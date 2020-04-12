// @flow strict-local

import {Bundler} from '@parcel/plugin';

export default new Bundler({
  bundle({bundleGraph}) {
    bundleGraph.traverseBundles({
      exit(bundle) {
        bundle.traverse((node, shouldWrap) => {
          if (node.type === 'dependency') {
            // Mark assets that should be wrapped, based on metadata in the incoming dependency tree
            if (shouldWrap || Boolean(node.value.meta.shouldWrap)) {
              let resolved = bundleGraph.getDependencyResolution(
                node.value,
                bundle,
              );
              if (resolved) {
                // $FlowFixMe resolved is not a MutableAsset, but this is still fine
                resolved.meta.shouldWrap = true;
              }
              return true;
            }
          }
        });
      },
    });
  },
});
