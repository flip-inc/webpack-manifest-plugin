const fse = require('fs-extra');
const path = require('path');

const _ = require('lodash');
const webpack = require('webpack');
const MemoryFileSystem = require('memory-fs');
const rimraf = require('rimraf');

const ManifestPlugin = require('../index.js');

jasmine.DEFAULT_TIMEOUT_INTERVAL = 5 * 60 * 1000;

const isCI = (yes, no) => process.env.CI === 'true' ? yes : no;

function webpackConfig(webpackOpts, opts) {
  return _.merge({
    plugins: [
      new ManifestPlugin(opts.manifestOptions)
    ]
  }, webpackOpts);
}

function webpackCompile(config, compilerOps, cb) {
  let compiler = webpack(config);

  _.assign(compiler, compilerOps);

  compiler.watch({
    aggregateTimeout: 300,
    poll: true
  }, (err, stats) => {
    expect(err).toBeFalsy();
    expect(stats.hasErrors()).toBe(false);

    cb(stats);
  });
};

describe('ManifestPlugin using real fs', () => {
  beforeEach(() => {
    rimraf.sync(path.join(__dirname, 'output/single-file'));
  });

  describe('basic behavior', () => {
    it('outputs a manifest of one file', done => {
      webpackCompile({
        context: __dirname,
        output: {
          filename: '[name].js',
          path: path.join(__dirname, 'output/single-file')
        },
        entry: './fixtures/file.js',
        plugins: [
          new ManifestPlugin()
        ]
      }, {}, () => {
        const manifest = JSON.parse(fse.readFileSync(path.join(__dirname, 'output/single-file/manifest.json')))

        expect(manifest).toBeDefined();
        expect(manifest).toEqual({
          'main.js': 'main.js'
        });

        done();
      });
    });

    it('exposes a plugin hook with the manifest content', done => {
      function TestPlugin() {
        this.manifest = null;
      }
      TestPlugin.prototype.apply = function(compiler) {
        const callback = (manifest, callback) => {
          this.manifest = manifest;
          callback();
        }
        if (compiler.hooks) {
          compiler.hooks.compilation.tap('ManifestPlugin', compilation => {
            compilation.hooks.webpackManifestPluginAfterEmit.tap('ManifestPlugin', callback);
          })
        } else {
          compiler.plugin('compilation', compilation => {
            compilation.plugin('webpack-manifest-plugin-after-emit', callback);
          });
        }
      };

      const testPlugin = new TestPlugin();
      webpackCompile({
        context: __dirname,
        output: {
          filename: '[name].js',
          path: path.join(__dirname, 'output/single-file')
        },
        entry: './fixtures/file.js',
        plugins: [
          new ManifestPlugin(),
          testPlugin
        ]
      }, {}, () => {
        expect(testPlugin.manifest).toBeDefined();
        expect(testPlugin.manifest).toEqual({
          'main.js': 'main.js'
        });

        done();
      });
    });
  });

  describe('watch mode', () => {
    let hashes;

    beforeAll(() => {
      fse.outputFileSync(path.join(__dirname, 'output/watch-mode/index.js'), 'console.log(\'v1\')');
      hashes = [];
    });

    it('outputs a manifest of one file', done => {
      webpackCompile({
        context: __dirname,
        output: {
          filename: '[name].[hash].js',
          path: path.join(__dirname, 'output/watch-mode')
        },
        entry: './output/watch-mode/index.js',
        watch: true,
        plugins: [
          new ManifestPlugin(),
          new webpack.HotModuleReplacementPlugin()
        ]
      }, {}, stats => {
        const manifest = JSON.parse(fse.readFileSync(path.join(__dirname, 'output/watch-mode/manifest.json')))

        expect(manifest).toBeDefined();
        expect(manifest).toEqual({
          'main.js': 'main.'+ stats.hash +'.js'
        });

        hashes.push(stats.hash);

        if (hashes.length === 2) {
          expect(hashes[0]).not.toEqual(hashes[1]);
          return done();
        }

        fse.outputFileSync(path.join(__dirname, 'output/watch-mode/index.js'), 'console.log(\'v2\')');
      });
    });
  });

  describe('multiple compilation', () => {
    const nbCompiler = isCI(4000, 1000);
    let originalTimeout;
    beforeEach(() => {
      rimraf.sync(path.join(__dirname, 'output/multiple-compilation'));
    });

    it('should not produce mangle output', done => {
      let seed = {};

      webpackCompile(Array.from({length: nbCompiler}).map((x, i) => ({
        context: __dirname,
        output: {
          filename: '[name].js',
          path: path.join(__dirname, 'output/multiple-compilation')
        },
        entry: {
          [`main-${i}`]: './fixtures/file.js'
        },
        plugins: [
          new ManifestPlugin({
            seed
          }),
          function () {
            const compiler = this;
            if (compiler.hooks) {
              compiler.hooks.afterEmit.tap('ManifestPlugin', compilation => {
                JSON.parse(fse.readFileSync(path.join(__dirname, 'output/multiple-compilation/manifest.json')));
              })
            } else {
              compiler.plugin('after-emit', (compilation, cb) => {
                JSON.parse(fse.readFileSync(path.join(__dirname, 'output/multiple-compilation/manifest.json')));
                cb();
              });
            }
          }
        ]
      })), {}, () => {
        const manifest = JSON.parse(fse.readFileSync(path.join(__dirname, 'output/multiple-compilation/manifest.json')))

        expect(manifest).toBeDefined();
        expect(manifest).toEqual(Array.from({length: nbCompiler}).reduce((manifest, x, i) => {
          manifest[`main-${i}.js`] = `main-${i}.js`;

          return manifest;
        }, {}));

        done();
      });
    });
  });

  describe('set location of manifest', () => {
    describe('using relative path', () => {
      beforeEach(() => {
        rimraf.sync(path.join(__dirname, 'output/relative-manifest'));
      });

      it('should use output to the correct location', done => {
        webpackCompile({
          context: __dirname,
          entry: './fixtures/file.js',
          output: {
            path: path.join(__dirname, 'output/relative-manifest'),
            filename: '[name].js'
          },
          plugins: [
            new ManifestPlugin({
              fileName: 'webpack.manifest.js',
            })
          ]
        }, {}, (manifest, stats, fs) => {
          const manifestPath = path.join(__dirname, 'output/relative-manifest', 'webpack.manifest.js');

          manifest = JSON.parse(fse.readFileSync(manifestPath).toString());

          expect(manifest).toEqual({
            'main.js': 'main.js'
          });

          done();
        });
      });
    });

    describe('using absolute path', () => {
      beforeEach(() => {
        rimraf.sync(path.join(__dirname, 'output/absolute-manifest'));
      });

      it('should use output to the correct location', done => {
        webpackCompile({
          context: __dirname,
          entry: './fixtures/file.js',
          output: {
            path: path.join(__dirname, 'output/absolute-manifest'),
            filename: '[name].js'
          },
          plugins: [
            new ManifestPlugin({
              fileName: path.join(__dirname, 'output/absolute-manifest', 'webpack.manifest.js')
            })
          ]
        }, {}, (manifest, stats, fs) => {
          const manifestPath = path.join(__dirname, 'output/absolute-manifest', 'webpack.manifest.js');

          manifest = JSON.parse(fse.readFileSync(manifestPath).toString());

          expect(manifest).toEqual({
            'main.js': 'main.js'
          });

          done();
        });
      });
    });
  });
});

describe('ManifestPlugin with memory-fs', () => {
  describe('writeToFileEmit', () => {
    beforeEach(() => {
      rimraf.sync(path.join(__dirname, 'output/emit'));
    });

    it('outputs a manifest of one file', done => {
      webpackCompile({
        context: __dirname,
        output: {
          filename: '[name].js',
          path: path.join(__dirname, 'output/emit')
        },
        entry: './fixtures/file.js',
        plugins: [
          new ManifestPlugin({
            writeToFileEmit: true
          })
        ]
      }, {
        outputFileSystem: new MemoryFileSystem()
      }, () => {
        const manifest = JSON.parse(fse.readFileSync(path.join(__dirname, 'output/emit/manifest.json')))

        expect(manifest).toBeDefined();
        expect(manifest).toEqual({
          'main.js': 'main.js'
        });

        done();
      });
    });
  });
});
