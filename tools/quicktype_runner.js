/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

const fs = require('fs');
const path = require('path');
const {
  InputData,
  JSONSchemaInput,
  JSONSchemaStore,
  TypeScriptTargetLanguage,
  parseJSON,
  quicktype,
} = require('quicktype-core');

/**
 * This file is pure JavaScript because Bazel only support compiling to ES5, while quicktype is
 * ES2015. This results in an incompatible call to `super()` in the FetchingJSONSchemaStore
 * class as it tries to call JSONSchemaStore's constructor in ES5.
 * TODO: move this file to typescript when Bazel supports ES2015 output.
 *
 * This file wraps around quicktype and can do one of two things;
 *
 * `node quicktype_runner.js <in_path> <out_path>`
 *   Reads the in path and outputs the TS file at the out_path.
 *
 * Using `-` as the out_path will output on STDOUT instead of a file.
 */

// Header to add to all files.
const header = `
// THIS FILE IS AUTOMATICALLY GENERATED. TO UPDATE THIS FILE YOU NEED TO CHANGE THE
// CORRESPONDING JSON SCHEMA FILE, THEN RUN devkit-admin build (or bazel build ...).

`;

// Footer to add to all files.
const footer = ``;

/**
 * The simplest Node JSONSchemaStore implementation we can build which supports our custom protocol.
 * Supports reading from ng-cli addresses, valid URLs and files (absolute).
 */
class FetchingJSONSchemaStore extends JSONSchemaStore {
  constructor(inPath) {
    super();
    this._inPath = inPath;
  }

  async fetch(address) {
    const URL = require('url');
    const url = URL.parse(address);
    let content = null;
    if (url.protocol === 'ng-cli:') {
      let filePath = path.join(__dirname, '../packages/angular/cli', url.hostname, url.path);
      content = fs.readFileSync(filePath, 'utf-8').trim();
    } else if (url.hostname) {
      try {
        const response = await fetch(address);
        content = response.text();
      } catch (e) {
        content = null;
      }
    }

    if (content === null && !path.isAbsolute(address)) {
      const resolvedPath = path.join(path.dirname(this._inPath), address);

      // Check relative to inPath
      if (fs.existsSync(resolvedPath)) {
        content = fs.readFileSync(resolvedPath, 'utf-8');
      }
    }

    if (content === null && fs.existsSync(address)) {
      content = fs.readFileSync(address, 'utf-8').trim();
    }

    if (content == null) {
      return undefined;
    }

    content = appendDeprecatedDescription(content);

    return parseJSON(content, 'JSON Schema', address);
  }
}

/**
 * Create the TS file from the schema, and overwrite the outPath (or log).
 * @param {string} inPath
 * @param {string} outPath
 */
async function main(inPath, outPath) {
  const content = await generate(inPath);

  if (outPath === '-') {
    console.log(content);
    process.exit(0);
  }

  const buildWorkspaceDirectory = process.env['BUILD_WORKSPACE_DIRECTORY'] || '.';
  outPath = path.resolve(buildWorkspaceDirectory, outPath);
  fs.writeFileSync(outPath, content, 'utf-8');
}

async function generate(inPath) {
  // Best description of how to use the API was found at
  //   https://blog.quicktype.io/customizing-quicktype/
  const inputData = new InputData();
  const content = fs.readFileSync(inPath, 'utf-8');
  const source = { name: 'Schema', schema: appendDeprecatedDescription(content) };

  await inputData.addSource('schema', source, () => {
    return new JSONSchemaInput(new FetchingJSONSchemaStore(inPath));
  });

  const lang = new TypeScriptTargetLanguage();

  const { lines } = await quicktype({
    lang,
    inputData,
    alphabetizeProperties: true,
    rendererOptions: {
      'prefer-types': 'true',
      'just-types': 'true',
      'explicit-unions': 'true',
      'acronym-style': 'camel',
    },
  });

  return header + lines.join('\n') + footer;
}

/**
 * Converts `x-deprecated` to `@deprecated` comments.
 * @param {string} schema
 */
function appendDeprecatedDescription(schema) {
  const content = JSON.parse(schema);
  const props = content.properties;

  for (const key in props) {
    let { description = '', 'x-deprecated': deprecated } = props[key];
    if (!deprecated) {
      continue;
    }

    description += '\n@deprecated' + (typeof deprecated === 'string' ? ` ${deprecated}` : '');
    props[key].description = description;
  }

  return JSON.stringify(content);
}

if (require.main === module) {
  // Parse arguments and run main().
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv.length > 3) {
    console.error('Must include 2 or 3 arguments.');
    process.exit(1);
  }

  main(argv[0], argv[1])
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('An error happened:');
      console.error(err);
      process.exit(127);
    });
}

exports.generate = generate;
