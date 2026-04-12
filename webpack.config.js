const path = require('path');

module.exports = (env, argv) => {
  const isProduction = argv && argv.mode === 'production';

  return {
    entry: {
      planner: './client/src/index.ts',
      auth: './client/src/auth.ts',
      dashboard: './client/src/dashboard.ts',
    },
    output: {
      filename: '[name]-bundle.js',
      path: path.resolve(__dirname, 'dist/public/js'),
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    externals: {},
    devServer: {
      static: [
        { directory: path.resolve(__dirname, 'public') },
        { directory: path.resolve(__dirname, 'dist/public'), publicPath: '/js' },
      ],
      port: 9000,
      open: true,
      proxy: [{ context: ['/api'], target: 'http://localhost:3000' }],
    },
    devtool: isProduction ? false : 'source-map',
  };
};
