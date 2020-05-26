import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as glob from '@actions/glob';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import * as util from './util';

export async function rewriteDefaultQueries(codeqlCmd: string) {
    const workspace = util.workspaceFolder();

    const rewriteFolder = path.join(workspace, 'rewritten-default-queries');
    await io.mkdirP(rewriteFolder);

    core.info('Collecting default queries');
    let qlpacks = '';
   
    await exec.exec(
      codeqlCmd, [
        'resolve',
        'qlpacks',
        '--format=json'
      ],{
        silent: true,
        listeners: {
          stdout: (data) => { qlpacks += data.toString(); },
          stderr: (data) => { process.stderr.write(data); }
        }
      });

    const qlpacksDictionary = JSON.parse(qlpacks);
    for (const [qlpack, paths] of Object.entries<string[]>(qlpacksDictionary)) {
        const qlpackFolder = path.join(rewriteFolder, qlpack);
        await io.mkdirP(qlpackFolder);

        const options = { recursive: true, force: false }
        await io.cp(paths[0], qlpackFolder, options);
    }

    core.info('Rewriting default Java queries');
    const queryFileGlobber = await glob.create(rewriteFolder + '/*java*/**/*.ql');
    for await (const file of queryFileGlobber.globGenerator()) {
        fs.readFile(file, 'utf8', (err, query) => {
            if (err) {
                throw new Error('Unable to read the default query "' +file+ '", because of error' + err);
            }

            if (query.search("@kind path-problem") !== -1) {
                const rewrittenQuery = query.replace('import DataFlow::PathGraph',"import DataFlow::PathGraph\nimport Extensions::AdditionalTaintSteps");
                fs.writeFile(file, rewrittenQuery, (err) => {
                    if (err) {
                        throw new Error('Unable to write the default query "' +file+ '", because of error:' + err);
                    }
                });
            }
        });
    }
    const queryPackGlobber = await glob.create(rewriteFolder + '/*java*/**/qlpack.yml');
    const qlpack = "codeql-java-extensions";
    for await (const file of queryPackGlobber.globGenerator()) {
      const parsedQLPack = yaml.safeLoad(fs.readFileSync(file, 'utf8'));
      let libraryPathDependencies = parsedQLPack.libraryPathDependencies;
      if (libraryPathDependencies && libraryPathDependencies instanceof Array) {
        libraryPathDependencies.push(qlpack);
      } else {
        libraryPathDependencies = [qlpack];
      }
      parsedQLPack.libraryPathDependencies = libraryPathDependencies;
      await fs.writeFile(file, yaml.safeDump(parsedQLPack), (err) => {
        if (err) {
          throw Error ("Failed to update qlpack definition at: '" + file + "', because of error: " + err);
        }
      });
    }

}