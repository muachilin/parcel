// @flow strict-local

import type {Asset, Bundle} from '@parcel/types';

import invariant from 'assert';
import {Bundler} from '@parcel/plugin';
import nullthrows from 'nullthrows';

export default new Bundler({
  // RULES:
  // 1. If dep.isAsync or dep.isEntry, start a new bundle group.

  bundle({bundleGraph}) {
    let bundleRoots: Map<Bundle, Array<Asset>> = new Map();
    let siblingBundlesByAsset: Map<string, Array<Bundle>> = new Map();

    // Step 1: create bundles for each of the explicit code split points.
    bundleGraph.traverse({
      enter: (node, context) => {
        if (node.type !== 'dependency') {
          return {
            ...context,
            bundleGroup: context?.bundleGroup,
            bundleByType: context?.bundleByType,
            bundleGroupDependency: context?.bundleGroupDependency,
            parentNode: node,
          };
        }

        let dependency = node.value;
        let assets = bundleGraph.getDependencyAssets(dependency);
        let resolution = bundleGraph.getDependencyResolution(dependency);

        if (
          (dependency.isEntry && resolution) ||
          (dependency.isAsync && resolution) ||
          resolution?.isIsolated ||
          resolution?.isInline
        ) {
          let bundleGroup = bundleGraph.createBundleGroup(
            dependency,
            nullthrows(dependency.target ?? context?.bundleGroup?.target),
          );

          let bundleByType: Map<string, Bundle> = new Map();

          for (let asset of assets) {
            let bundle = bundleGraph.createBundle({
              entryAsset: asset,
              isEntry: asset.isIsolated ? false : Boolean(dependency.isEntry),
              isInline: asset.isInline,
              target: bundleGroup.target,
            });
            bundleByType.set(bundle.type, bundle);
            bundleRoots.set(bundle, [asset]);
            siblingBundlesByAsset.set(asset.id, []);
            bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          }

          return {
            bundleGroup,
            bundleByType,
            bundleGroupDependency: dependency,
            parentNode: node,
          };
        }

        invariant(context != null);
        invariant(context.parentNode.type === 'asset');
        let parentAsset = context.parentNode.value;
        let bundleGroup = nullthrows(context.bundleGroup);
        let bundleGroupDependency = nullthrows(context.bundleGroupDependency);
        let bundleByType = nullthrows(context.bundleByType);
        let siblingBundles = nullthrows(
          siblingBundlesByAsset.get(parentAsset.id),
        );
        let allSameType = assets.every(a => a.type === parentAsset.type);

        for (let asset of assets) {
          let siblings = siblingBundlesByAsset.get(asset.id);

          if (parentAsset.type === asset.type) {
            if (allSameType && siblings) {
              // If any sibling bundles were created for this asset or its subtree previously,
              // add them all to the current bundle group as well. This fixes cases where two entries
              // depend on a shared asset which has siblings. Due to DFS, the subtree of the shared
              // asset is only processed once, meaning any sibling bundles created due to type changes
              // would only be connected to the first bundle group. To work around this, we store a list
              // of sibling bundles for each asset in the graph, and when we re-visit a shared asset, we
              // connect them all to the current bundle group as well.
              for (let bundle of siblings) {
                bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
              }
            } else if (!siblings) {
              // Propagate the same siblings further if there are no bundles being created in this
              // asset group, otherwise start a new set of siblings.
              siblingBundlesByAsset.set(
                asset.id,
                allSameType ? siblingBundles : [],
              );
            }

            continue;
          }

          let existingBundle = bundleByType.get(asset.type);
          if (existingBundle) {
            // If a bundle of this type has already been created in this group,
            // merge this subgraph into it.
            nullthrows(bundleRoots.get(existingBundle)).push(asset);
            bundleGraph.createAssetReference(dependency, asset);
          } else {
            let bundle = bundleGraph.createBundle({
              entryAsset: asset,
              target: bundleGroup.target,
              isEntry: bundleGroupDependency.isEntry,
              isInline: asset.isInline,
            });
            bundleByType.set(bundle.type, bundle);
            siblingBundles.push(bundle);
            bundleRoots.set(bundle, [asset]);
            bundleGraph.createAssetReference(dependency, asset);
            bundleGraph.addBundleToBundleGroup(bundle, bundleGroup);
          }

          if (!siblings) {
            siblingBundlesByAsset.set(asset.id, []);
          }
        }

        return {
          ...context,
          parentNode: node,
        };
      },
    });

    for (let [bundle, rootAssets] of bundleRoots) {
      for (let asset of rootAssets) {
        bundleGraph.addAssetGraphToBundle(asset, bundle);
      }
    }
  },
});
