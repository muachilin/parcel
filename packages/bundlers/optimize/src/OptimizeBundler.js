// @flow strict-local

import type {
  Asset,
  Bundle,
  BundleGroup,
  MutableBundleGraph,
} from '@parcel/types';

import invariant from 'assert';
import {Bundler} from '@parcel/plugin';
import {md5FromString} from '@parcel/utils';

const OPTIONS = {
  minBundles: 1,
  minBundleSize: 30000,
  maxParallelRequests: 5,
};

export default new Bundler({
  // RULES:
  // 2. If an asset is a different type than the current bundle, make a parallel bundle in the same bundle group.
  // 3. If an asset is already in a parent bundle in the same entry point, exclude from child bundles.
  // 4. If an asset is only in separate isolated entry points (e.g. workers, different HTML pages), duplicate it.
  // 5. If the sub-graph from an asset is >= 30kb, and the number of parallel requests in the bundle group is < 5, create a new bundle containing the sub-graph.
  // 6. If two assets are always seen together, put them in the same extracted bundle

  bundle({bundleGraph}) {
    // Step 2: Remove asset graphs that begin with entries to other bundles.
    bundleGraph.traverseBundles(bundle => {
      if (bundle.isInline || !bundle.isSplittable) {
        return;
      }

      let mainEntry = bundle.getMainEntry();
      if (mainEntry == null) {
        return;
      }

      let siblings = bundleGraph
        .getSiblingBundles(bundle)
        .filter(sibling => !sibling.isInline);
      let candidates = bundleGraph.findBundlesWithAsset(mainEntry).filter(
        containingBundle =>
          containingBundle.id !== bundle.id &&
          // Don't add to BundleGroups for entry bundles, as that would require
          // another entry bundle depending on these conditions, making it difficult
          // to predict and reference.
          !containingBundle.isEntry &&
          !containingBundle.isInline &&
          containingBundle.isSplittable,
      );

      for (let candidate of candidates) {
        let bundleGroups = bundleGraph.getBundleGroupsContainingBundle(
          candidate,
        );
        if (
          Array.from(bundleGroups).every(
            group =>
              bundleGraph.getBundlesInBundleGroup(group).length <
              OPTIONS.maxParallelRequests,
          )
        ) {
          bundleGraph.removeAssetGraphFromBundle(mainEntry, candidate);
          for (let bundleGroup of bundleGroups) {
            for (let bundleToAdd of [bundle, ...siblings]) {
              bundleGraph.addBundleToBundleGroup(bundleToAdd, bundleGroup);
            }
          }
        }
      }
    });

    // Step 3: Remove assets that are duplicated in a parent bundle.
    bundleGraph.traverseBundles({
      exit(bundle) {
        deduplicateBundle(bundleGraph, bundle);
      },
    });

    // Step 4: Find duplicated assets in different bundle groups, and separate them into their own parallel bundles.
    // If multiple assets are always seen together in the same bundles, combine them together.
    let candidateBundles: Map<
      string,
      {|
        assets: Array<Asset>,
        sourceBundles: Set<Bundle>,
        size: number,
      |},
    > = new Map();

    bundleGraph.traverseContents((node, ctx, actions) => {
      if (node.type !== 'asset') {
        return;
      }

      let asset = node.value;
      let containingBundles = bundleGraph
        .findBundlesWithAsset(asset)
        // Don't create shared bundles from entry bundles, as that would require
        // another entry bundle depending on these conditions, making it difficult
        // to predict and reference.
        .filter(b => {
          let mainEntry = b.getMainEntry();

          return (
            !b.isEntry &&
            b.isSplittable &&
            (mainEntry == null || mainEntry.id !== asset.id)
          );
        });

      if (containingBundles.length > OPTIONS.minBundles) {
        let id = containingBundles
          .map(b => b.id)
          .sort()
          .join(':');

        let candidate = candidateBundles.get(id);
        if (candidate) {
          candidate.assets.push(asset);
          for (let bundle of containingBundles) {
            candidate.sourceBundles.add(bundle);
          }
          candidate.size += bundleGraph.getTotalSize(asset);
        } else {
          candidateBundles.set(id, {
            assets: [asset],
            sourceBundles: new Set(containingBundles),
            size: bundleGraph.getTotalSize(asset),
          });
        }

        // Skip children from consideration since we added a parent already.
        actions.skipChildren();
      }
    });

    // Sort candidates by size (consider larger bundles first), and ensure they meet the size threshold
    let sortedCandidates: Array<{|
      assets: Array<Asset>,
      sourceBundles: Set<Bundle>,
      size: number,
    |}> = Array.from(candidateBundles.values())
      .filter(bundle => bundle.size >= OPTIONS.minBundleSize)
      .sort((a, b) => b.size - a.size);

    for (let {assets, sourceBundles} of sortedCandidates) {
      // Find all bundle groups connected to the original bundles
      let bundleGroups = new Set();

      for (let bundle of sourceBundles) {
        for (let bundleGroup of bundleGraph.getBundleGroupsContainingBundle(
          bundle,
        )) {
          bundleGroups.add(bundleGroup);
        }
      }

      // Check that all the bundle groups are inside the parallel request limit.
      if (
        Array.from(bundleGroups).some(
          group =>
            bundleGraph.getBundlesInBundleGroup(group).length >=
            OPTIONS.maxParallelRequests,
        )
      ) {
        continue;
      }

      let [firstBundle] = [...sourceBundles];
      let sharedBundle = bundleGraph.createBundle({
        uniqueKey: md5FromString([...sourceBundles].map(b => b.id).join(':')),
        // Allow this bundle to be deduplicated. It shouldn't be further split.
        // TODO: Reconsider bundle/asset flags.
        isSplittable: true,
        env: firstBundle.env,
        target: firstBundle.target,
        type: firstBundle.type,
      });

      // Remove all of the root assets from each of the original bundles
      for (let asset of assets) {
        bundleGraph.addAssetGraphToBundle(asset, sharedBundle);
        for (let bundle of sourceBundles) {
          bundleGraph.removeAssetGraphFromBundle(asset, bundle);
        }
      }

      // Create new bundle node and connect it to all of the original bundle groups
      for (let bundleGroup of bundleGroups) {
        bundleGraph.addBundleToBundleGroup(sharedBundle, bundleGroup);
      }

      deduplicateBundle(bundleGraph, sharedBundle);
    }

    // Step 5: Mark async dependencies on assets that are already available in
    // the bundle as internally resolvable. This removes the dependency between
    // the bundle and the bundle group providing that asset. If all connections
    // to that bundle group are removed, remove that bundle group.
    let asyncBundleGroups: Set<BundleGroup> = new Set();
    bundleGraph.traverse(node => {
      if (
        node.type !== 'dependency' ||
        node.value.isEntry ||
        !node.value.isAsync
      ) {
        return;
      }

      let dependency = node.value;
      let resolution = bundleGraph.getDependencyResolution(dependency);
      if (resolution == null) {
        return;
      }

      let externalResolution = bundleGraph.resolveExternalDependency(
        dependency,
      );
      invariant(externalResolution?.type === 'bundle_group');
      asyncBundleGroups.add(externalResolution.value);

      for (let bundle of bundleGraph.findBundlesWithDependency(dependency)) {
        if (
          bundle.hasAsset(resolution) ||
          bundleGraph.isAssetInAncestorBundles(bundle, resolution)
        ) {
          bundleGraph.internalizeAsyncDependency(bundle, dependency);
        }
      }
    });

    // Remove any bundle groups that no longer have any parent bundles.
    for (let bundleGroup of asyncBundleGroups) {
      if (bundleGraph.getParentBundlesOfBundleGroup(bundleGroup).length === 0) {
        bundleGraph.removeBundleGroup(bundleGroup);
      }
    }
  },
});

function deduplicateBundle(bundleGraph: MutableBundleGraph, bundle: Bundle) {
  if (bundle.env.isIsolated() || !bundle.isSplittable) {
    // If a bundle's environment is isolated, it can't access assets present
    // in any ancestor bundles. Don't deduplicate any assets.
    return;
  }

  bundle.traverse(node => {
    if (node.type !== 'dependency') {
      return;
    }

    let dependency = node.value;
    let assets = bundleGraph.getDependencyAssets(dependency);

    for (let asset of assets) {
      if (
        bundle.hasAsset(asset) &&
        bundleGraph.isAssetInAncestorBundles(bundle, asset)
      ) {
        bundleGraph.removeAssetGraphFromBundle(asset, bundle);
      }
    }
  });
}