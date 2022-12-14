import { getInput, info, setFailed, setOutput } from '@actions/core';
import * as core from '@actions/core';
import { context } from '@actions/github';
import { NxJson } from '@nrwl/workspace';
import { promises as fs } from 'fs';

import { exec } from './exec';

interface Changes {
  apps: string[];
  libs: string[];
  implicitDependencies: string[];
}

interface Refs {
  base: string;
  head: string;
}

const getBaseAndHeadRefs = ({ base, head }: Partial<Refs>): Refs => {
  if (!base && !head) {
    switch (context.eventName) {
      case 'pull_request':
        base = context.payload.pull_request?.base?.sha as string;
        head = context.payload.pull_request?.head?.sha as string;
        break;
      case 'push':
        base = context.payload.before as string;
        head = context.payload.after as string;
        break;
      default:
        throw new Error(`Unsupported event: ${context.eventName}`);
    }
  }

  if (!base || !head) {
    throw new Error(`Base or head refs are missing`);
  }

  info(`Event name: ${context.eventName}`);
  info(`Base ref: ${base}`);
  info(`Head ref: ${head}`);

  return {
    base,
    head
  };
};

const parseGitDiffOutput = (output: string): string[] => {
  const tokens = output.split('\u0000').filter(s => s.length > 0);
  const files: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    files.push(tokens[i + 1]);
  }
  return files;
};

const fixStdOutNullTermination = () => {
  // Previous command uses NULL as delimiters and output is printed to stdout.
  // We have to make sure next thing written to stdout will start on new line.
  // Otherwise things like ::set-output wouldn't work.
  core.info('');
};

const getChangedFiles = async (base: string, head: string): Promise<string[]> => {
  core.startGroup(`Detecting changes ${base}...${head}`);

  await exec('git', ['checkout', base]);
  await exec('git', ['checkout', head]);

  const stdout = (
    await exec('git', ['diff', '--no-renames', '--name-status', '-z', `${base}...${head}`])
  ).stdout;

  fixStdOutNullTermination();
  core.endGroup();

  return parseGitDiffOutput(stdout);
};

const readNxFile = async (): Promise<NxJson> => {
  const nxFile = await fs.readFile('nx.json', { encoding: 'utf-8' });
  return JSON.parse(nxFile) as NxJson;
};

const dirFinder = (dir: string): ((file: string) => string | undefined) => {
  const pathRegExp = new RegExp(`^${dir}/([^/]+)`);
  return (file: string) => file.match(pathRegExp)?.[1];
};

const getChanges = ({
  appsDir,
  libsDir,
  implicitDependencies,
  changedFiles
}: {
  appsDir: string;
  libsDir: string;
  implicitDependencies: string[];
  changedFiles: string[];
}): Changes => {
  const findApp = dirFinder(appsDir);
  const findLib = dirFinder(libsDir);
  const findImplicitDependencies = (file: string) =>
    implicitDependencies.find(dependency => file === dependency);

  const changes = changedFiles.reduce<{
    apps: Set<string>;
    libs: Set<string>;
    implicitDependencies: string[];
  }>(
    (accumulatedChanges, file) => {
      const app = findApp(file);
      if (app) {
        accumulatedChanges.apps.add(app);
      }
      const lib = findLib(file);
      if (lib) {
        accumulatedChanges.libs.add(lib);
      }
      const implicitDependency = findImplicitDependencies(file);
      if (implicitDependency) {
        accumulatedChanges.implicitDependencies.push(implicitDependency);
      }
      return accumulatedChanges;
    },
    {
      apps: new Set<string>(),
      libs: new Set<string>(),
      implicitDependencies: []
    }
  );

  return {
    apps: [...changes.apps.values()],
    libs: [...changes.libs.values()],
    implicitDependencies: changes.implicitDependencies
  };
};

const main = async () => {
  const { base, head } = getBaseAndHeadRefs({
    base: getInput('baseRef'),
    head: getInput('headRef')
  });

  const changedFiles = await getChangedFiles(base, head);

  const nxFile = await readNxFile();
  const implicitDependencies = nxFile.implicitDependencies
    ? Object.keys(nxFile.implicitDependencies)
    : [];
  const appsDir = nxFile.workspaceLayout?.appsDir || 'apps';
  const libsDir = nxFile.workspaceLayout?.libsDir || 'libs';

  const changes = getChanges({
    appsDir,
    libsDir,
    implicitDependencies,
    changedFiles
  });

  console.log('');

  console.log('changed apps:');
  console.log(changes.apps);

  console.log('changed libs:');
  console.log(changes.libs);

  console.log('changed implicit dependencies:');
  console.log(changes.implicitDependencies);

  setOutput('changed-apps', changes.apps.join(' '));
  setOutput('changed-libs', changes.libs.join(' '));
  setOutput('changed-dirs', [...changes.apps, ...changes.libs].join(' '));
  setOutput('changed-implicit-dependencies', changes.implicitDependencies.join(' '));
  setOutput(
    'not-affected',
    changes.apps.length === 0 &&
      changes.libs.length === 0 &&
      changes.implicitDependencies.length === 0
  );
};

main().catch(error => setFailed(error));
