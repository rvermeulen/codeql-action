import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as configUtils from './config-utils';
import * as externalQueries from "./external-queries";
import * as sharedEnv from './shared-environment';
import * as upload_lib from './upload-lib';
import * as util from './util';
import * as rewriteQueries from './rewrite-queries';

function getMemoryFlag(): string {
  let memoryToUseMegaBytes: number;
  const memoryToUseString = core.getInput("ram");
  if (memoryToUseString) {
    memoryToUseMegaBytes = Number(memoryToUseString);
    if (Number.isNaN(memoryToUseMegaBytes) || memoryToUseMegaBytes <= 0) {
      throw new Error("Invalid RAM setting \"" + memoryToUseString + "\", specified.");
    }
  } else {
    const totalMemoryBytes = os.totalmem();
    const totalMemoryMegaBytes = totalMemoryBytes / (1024 * 1024);
    const systemReservedMemoryMegaBytes = 256;
    memoryToUseMegaBytes = totalMemoryMegaBytes - systemReservedMemoryMegaBytes;
  }
  return "--ram=" + Math.floor(memoryToUseMegaBytes);
}

async function createdDBForScannedLanguages(codeqlCmd: string, databaseFolder: string) {
  const scannedLanguages = process.env[sharedEnv.CODEQL_ACTION_SCANNED_LANGUAGES];
  if (scannedLanguages) {
    for (const language of scannedLanguages.split(',')) {
      core.startGroup('Extracting ' + language);

      // Get extractor location
      let extractorPath = '';
      await exec.exec(codeqlCmd, ['resolve', 'extractor', '--format=json', '--language=' + language], {
        silent: true,
        listeners: {
          stdout: (data) => { extractorPath += data.toString(); },
          stderr: (data) => { process.stderr.write(data); }
        }
      });

      // Set trace command
      const ext = process.platform === 'win32' ? '.cmd' : '.sh';
      const traceCommand = path.resolve(JSON.parse(extractorPath), 'tools', 'autobuild' + ext);

      // Run trace command
      await exec.exec(
        codeqlCmd,
        ['database', 'trace-command', path.join(databaseFolder, language), '--', traceCommand]);

      core.endGroup();
    }
  }
}

async function finalizeDatabaseCreation(codeqlCmd: string, databaseFolder: string) {
  await createdDBForScannedLanguages(codeqlCmd, databaseFolder);

  const languages = process.env[sharedEnv.CODEQL_ACTION_LANGUAGES] || '';
  for (const language of languages.split(',')) {
    core.startGroup('Finalizing ' + language);
    await exec.exec(codeqlCmd, ['database', 'finalize', path.join(databaseFolder, language)]);
    core.endGroup();
  }
}

async function resolveQueryLanguages(codeqlCmd: string, config: configUtils.Config): Promise<Map<string, string[]>> {
  let res = new Map();

  if (config.additionalQueries.length !== 0) {
    let resolveQueriesOutput = '';
    const options = {
      listeners: {
        stdout: (data: Buffer) => {
          resolveQueriesOutput += data.toString();
        }
      }
    };

    const codeqlCmdArgs = ['resolve', 'queries', ...config.additionalQueries, '--format=bylanguage'];
    if (config.additionalQueryLibraries.length !== 0) {
      codeqlCmdArgs.push("--search-path="+config.additionalQueryLibraries.join(':'));
    }

    if (config.verbose > 0) {
      codeqlCmdArgs.push("-" + "v".repeat(config.verbose));
    }

    await exec.exec(codeqlCmd, codeqlCmdArgs, options);

    const resolveQueriesOutputObject = JSON.parse(resolveQueriesOutput);

    for (const [language, queries] of Object.entries(resolveQueriesOutputObject.byLanguage)) {
      res[language] = Object.keys(<any>queries);
    }

    const noDeclaredLanguage = resolveQueriesOutputObject.noDeclaredLanguage;
    const noDeclaredLanguageQueries = Object.keys(noDeclaredLanguage);
    if (noDeclaredLanguageQueries.length !== 0) {
      throw new Error('Some queries do not declare a language, their qlpack.yml file is missing or is invalid');
    }

    const multipleDeclaredLanguages = resolveQueriesOutputObject.multipleDeclaredLanguages;
    const multipleDeclaredLanguagesQueries = Object.keys(multipleDeclaredLanguages);
    if (multipleDeclaredLanguagesQueries.length !== 0) {
      throw new Error('Some queries declare multiple languages, their qlpack.yml file is missing or is invalid');
    }
  }

  return res;
}

// Runs queries and creates sarif files in the given folder
async function runQueries(codeqlCmd: string, databaseFolder: string, sarifFolder: string, config: configUtils.Config) {
  const queriesPerLanguage = await resolveQueryLanguages(codeqlCmd, config);

  const workspace = util.workspaceFolder();
  const rewriteFolder = path.join(workspace, 'rewritten-default-queries');

  for (let database of fs.readdirSync(databaseFolder)) {
    core.startGroup('Analyzing ' + database);

    const queries: string[] = [];
    if (!config.disableDefaultQueries) {
      queries.push(database + '-code-scanning.qls');
    }
    queries.push(...(queriesPerLanguage[database] || []));

    const sarifFile = path.join(sarifFolder, database + '.sarif');

    const codeqlCmdArgs = [
      'database',
      'analyze',
      getMemoryFlag(),
      path.join(databaseFolder, database),
      '--format=sarif-latest',
      '--output=' + sarifFile,
      '--no-sarif-add-snippets',
      ...queries
    ];

    const additionalPacks : string[] = [];
    let searchPaths : string[] = [];
    if (config.extensionsPackDir !== "") {
      additionalPacks.push(rewriteFolder);
      searchPaths.push(config.extensionsPackDir);
    }

    if (config.additionalQueryLibraries.length !== 0) {
      searchPaths = searchPaths.concat(config.additionalQueryLibraries);
    }
    
    if (additionalPacks.length !== 0) {
      codeqlCmdArgs.push("--additional-packs=" + additionalPacks.join(':'));
    }

    if (searchPaths.length !== 0) {
      codeqlCmdArgs.push("--search-path=" + searchPaths.join(':'));
    }

    if (config.verbose > 0) {
      codeqlCmdArgs.push("-" + "v".repeat(config.verbose));
    }
    
    await exec.exec(codeqlCmd, codeqlCmdArgs);
  
    core.debug('SARIF results for database ' + database + ' created at "' + sarifFile + '"');
    core.endGroup();
  }
}

async function run() {
  try {
    if (util.should_abort('finish', true) || !await util.reportActionStarting('finish')) {
      return;
    }
    const config = await configUtils.loadConfig();

    core.exportVariable(sharedEnv.ODASA_TRACER_CONFIGURATION, '');
    delete process.env[sharedEnv.ODASA_TRACER_CONFIGURATION];

    const codeqlCmd = util.getRequiredEnvParam(sharedEnv.CODEQL_ACTION_CMD);
    const databaseFolder = util.getRequiredEnvParam(sharedEnv.CODEQL_ACTION_DATABASE_DIR);

    const sarifFolder = core.getInput('output');
    await io.mkdirP(sarifFolder);

    core.info('Finalizing database creation');
    await finalizeDatabaseCreation(codeqlCmd, databaseFolder);

    await externalQueries.checkoutExternalQueries(config);

    if (config.extensionsPackDir !== "") {
      rewriteQueries.rewriteDefaultQueries(codeqlCmd);
    }

    core.info('Analyzing database');
    await runQueries(codeqlCmd, databaseFolder, sarifFolder, config);

    if ('true' === core.getInput('upload')) {
      if (!await upload_lib.upload(sarifFolder)) {
        await util.reportActionFailed('failed', 'upload');
        return;
      }
    }

  } catch (error) {
    core.setFailed(error.message);
    await util.reportActionFailed('finish', error.message, error.stack);
    return;
  }

  await util.reportActionSucceeded('finish');
}

run().catch(e => {
  core.setFailed("analyze action failed: " + e);
  console.log(e);
});
