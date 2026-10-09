import * as path from 'path';
import { userDataPath } from './paths';
import { fileWrites } from './file-writes';
import { assertPanelActive } from './fsapi';
import type { planPluginPack } from '../shared/ensoulpack';
import type { ExtensionInstallScope } from '../shared/storage';

type PluginFiles = Pick<ReturnType<typeof planPluginPack>, 'id' | 'targetDir' | 'files'>;

export function pluginInstallDirectory(plan: Pick<PluginFiles, 'id' | 'targetDir'>, workspace: string, scope: ExtensionInstallScope = 'user'): string {
  if (scope === 'user') return userDataPath('.ensoul', 'plugins', plan.id);
  if (scope !== 'workspace') throw new Error('扩展安装范围无效');
  if (!workspace) throw new Error('还没选工作区');
  return path.join(workspace, plan.targetDir);
}

export function installPluginFiles(plan: PluginFiles, workspace: string, scope: ExtensionInstallScope = 'user'): string {
  const directory = pluginInstallDirectory(plan, workspace, scope);
  for (const file of plan.files) {
    assertPanelActive();
    fileWrites.write(path.join(directory, file.rel), file.data, false);
  }
  return directory;
}
