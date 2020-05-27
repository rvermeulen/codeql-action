import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as configUtils from './config-utils';

import * as util from './util';

interface Dictionary<T> {
  [key: string]: T;
}

export async function rewriteDefaultQueries(codeqlCmd: string, config: configUtils.Config) {
  const workspace = util.workspaceFolder();

  const rewriteFolder = path.join(workspace, 'rewritten-ql-packs');
  await io.mkdirP(rewriteFolder);

  core.startGroup("CodeQL QL pack rewriting for query extensions")
  let qlpacks = '';

  core.info("Collecting QL packs");
  await exec.exec(
    codeqlCmd, [
    'resolve',
    'qlpacks',
    '--format=json'
  ], {
    silent: true,
    listeners: {
      stdout: (data) => { qlpacks += data.toString(); },
      stderr: (data) => { process.stderr.write(data); }
    }
  });

  const qlpacksDictionary: Dictionary<Array<string>> = JSON.parse(qlpacks);
  for (const queryExtension of config.queryExtensions) {
    if (qlpacksDictionary[queryExtension.target]) {
      core.info('Found QL pack "' + queryExtension.target + '" targeted by query extension "' + queryExtension.name + '"');

      const qlpackFolder = path.join(rewriteFolder, queryExtension.target);
      core.info('Creating rewrite folder "' + qlpackFolder + '"');
      io.mkdirP(qlpackFolder);

      const options = { recursive: true, force: false }
      const firstPath = qlpacksDictionary[queryExtension.target][0];
      core.info('Copying "' + firstPath + '" to rewrite folder "' + qlpackFolder + '"');
      io.cp(firstPath, qlpackFolder, options);

      core.info('Rewriting QL pack "' + queryExtension.target + '" by looking for query files in "' + qlpackFolder + '/**/*.ql"');
      const queryFileGlobber = await glob.create(qlpackFolder + '/**/*.ql');
      const queryFiles = await queryFileGlobber.glob();
      core.info('Found ' + queryFiles.length + ' query files');
      let rewrittenQueryCount = 0;
      for await (const file of queryFiles) {
        fs.readFile(file, 'utf8', (err, query) => {
          if (err) {
            throw new Error('Unable to read the query "' + file + '", because of error' + err);
          }

          if (query.search(queryExtension.trigger) !== -1) {
            core.info('Rewriting query "' + file + '"');
            const rewrittenImports = [queryExtension.trigger].concat(queryExtension.imports);
            const rewrittenQuery = query.replace(queryExtension.trigger, rewrittenImports.join("\n"));
            fs.writeFile(file, rewrittenQuery, (err) => {
              if (err) {
                throw new Error('Unable to write the query "' + file + '", because of error:' + err);
              }
            });
            rewrittenQueryCount++;
          } else {
            core.info('Query file "' + file + '" does not contain the trigger "' + queryExtension.trigger + '"');
          }
        });
      }
      core.info('Rewritten ' + rewrittenQueryCount + ' queries.');
      if (rewrittenQueryCount !== 0) {
        core.info('Updating QL pack library dependencies');
        const queryExtensionPack = yaml.safeLoad(fs.readFileSync(path.join(queryExtension.uses, 'qlpack.yml'), 'utf8'));
        const queryPackGlobber = await glob.create(qlpackFolder + '/**/qlpack.yml');
        for await (const file of queryPackGlobber.globGenerator()) {
          const queryPack = yaml.safeLoad(fs.readFileSync(file, 'utf8'));
          if (queryPack.name !== queryExtension.target) {
            core.info('Skipping QL pack "' + file + '" not matching the target "' + queryExtension.target + '"');
            continue;
          }
          let libraryPathDependencies = queryPack.libraryPathDependencies;
          if (libraryPathDependencies && libraryPathDependencies instanceof Array) {
            libraryPathDependencies.push(queryExtensionPack.name);
          } else {
            libraryPathDependencies = [queryExtensionPack.name];
          }
          queryPack.libraryPathDependencies = libraryPathDependencies;
          core.info('Adding library dependency "' + queryExtensionPack.name + '" to QL pack "' + file + '"');
          fs.writeFile(file, yaml.safeDump(queryPack), (err) => {
            if (err) {
              throw Error("Failed to update qlpack at: '" + file + "', because of error: " + err);
            }
          });
        }
      }
    }
  };
  core.endGroup();
}