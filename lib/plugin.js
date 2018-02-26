const path = require('path');
const fse = require('fs-extra');
const _ = require('lodash');
const mutexify = require('mutexify');

const lock = mutexify();

function ManifestPlugin(opts) {
  this.opts = _.assign({
    basePath: '',
    fileName: 'manifest.json',
    transformExtensions: /^(gz|map)$/i,
    writeToFileEmit: false,
    seed: null,
    filter: null,
    map: null,
    generate: null,
    sort: null,
    serialize: manifest => JSON.stringify(manifest, null, 2),
  }, opts || {});
}

ManifestPlugin.prototype.getFileType = function(str) {
  str = str.replace(/\?.*/, '');
  const split = str.split('.');
  let ext = split.pop();
  if (this.opts.transformExtensions.test(ext)) {
    ext = split.pop() + '.' + ext;
  }
  return ext;
};

ManifestPlugin.prototype.apply = function(compiler) {
  const seed = this.opts.seed || {};
  const moduleAssets = {};

  const moduleAsset = (module, file) => {
    moduleAssets[file] = path.join(
      path.dirname(file),
      path.basename(module.userRequest)
    );
  };

  const emit = (compilation, compileCallback) => {
    const publicPath = compilation.options.output.publicPath;
    const stats = compilation.getStats().toJson();

    let files = compilation.chunks.reduce((files, chunk) => {
      return chunk.files.reduce((files, path) => {
        let name = chunk.name ? chunk.name : null;

        if (name) {
          name = name + '.' + this.getFileType(path);
        } else {
          // For nameless chunks, just map the files directly.
          name = path;
        }

        // Webpack 4: .isOnlyInitial()
        // Webpack 3: .isInitial()
        // Webpack 1/2: .initial
        return files.concat({
          path: path,
          chunk: chunk,
          name: name,
          isInitial: chunk.isOnlyInitial ? chunk.isOnlyInitial() : (chunk.isInitial ? chunk.isInitial() : chunk.initial),
          isChunk: true,
          isAsset: false,
          isModuleAsset: false
        });
      }, files);
    }, []);

    // module assets don't show up in assetsByChunkName.
    // we're getting them this way;
    files = stats.assets.reduce((files, asset) => {
      const name = moduleAssets[asset.name];
      if (name) {
        return files.concat({
          path: asset.name,
          name: name,
          isInitial: false,
          isChunk: false,
          isAsset: true,
          isModuleAsset: true
        });
      }

      const isEntryAsset = asset.chunks.length > 0;
      if (isEntryAsset) {
        return files;
      }

      return files.concat({
        path: asset.name,
        name: asset.name,
        isInitial: false,
        isChunk: false,
        isAsset: true,
        isModuleAsset: false
      });
    }, files);

    // Don't add hot updates to manifest
    files = files.filter(file => !file.path.includes('hot-update'));

    // Append optional basepath onto all references.
    // This allows output path to be reflected in the manifest.
    if (this.opts.basePath) {
      files = files.map(file => {
        file.name = this.opts.basePath + file.name;
        return file;
      });
    }

    if (publicPath) {
      // Similar to basePath but only affects the value (similar to how
      // output.publicPath turns require('foo/bar') into '/public/foo/bar', see
      // https://github.com/webpack/docs/wiki/configuration#outputpublicpath
      files = files.map(file => {
        file.path = publicPath + file.path;
        return file;
      });
    }

    files = files.map(file => {
      file.name = file.name.replace(/\\/g, '/');
      file.path = file.path.replace(/\\/g, '/');
      return file;
    });

    if (this.opts.filter) {
      files = files.filter(this.opts.filter);
    }

    if (this.opts.map) {
      files = files.map(this.opts.map);
    }

    if (this.opts.sort) {
      files = files.sort(this.opts.sort);
    }

    let manifest;
    if (this.opts.generate) {
      manifest = this.opts.generate(seed, files);
    } else {
      manifest = files.reduce((manifest, file) => {
        manifest[file.name] = file.path;
        return manifest;
      }, seed);
    }

    const output = this.opts.serialize(manifest);

    const outputFolder = compilation.options.output.path;
    const outputFile = path.resolve(compilation.options.output.path, this.opts.fileName);
    const outputName = path.relative(outputFolder, outputFile);

    compilation.assets[outputName] = {
      source: function() {
        return output;
      },
      size: function() {
        return output.length;
      }
    };

    if (this.opts.writeToFileEmit) {
      fse.outputFileSync(outputFile, output);
    }

    // NOTE: make sure webpack is not writing multiple manifests simultaneously
    lock(function(release) {
      if (compiler.hooks) {
        compiler.hooks.afterEmit.tap('ManifestPlugin', compilation => {
          release();
        });

        compilation.hooks.webpackManifestPluginAfterEmit.call(manifest, compileCallback);
      } else {
        compiler.plugin('after-emit', (compilation, cb) => {
          release();
          cb();
        });
  
        compilation.applyPluginsAsync('webpack-manifest-plugin-after-emit', manifest, compileCallback);
      }
    });
  };

  if (compiler.hooks) {
    compiler.hooks.compilation.tap('ManifestPlugin', compilation => {

      const SyncWaterfallHook = require('tapable').SyncWaterfallHook;

      compilation.hooks.webpackManifestPluginAfterEmit = new SyncWaterfallHook(['manifest', 'compileCallback']);

      compilation.hooks.moduleAsset.tap('ManifestPlugin', moduleAsset);
    });
    compiler.hooks.emit.tap('ManifestPlugin', emit);
  } else {
    compiler.plugin('compilation', compilation => {
      compilation.plugin('module-asset', moduleAsset);
    });
    compiler.plugin('emit', emit);
  }
};

module.exports = ManifestPlugin;