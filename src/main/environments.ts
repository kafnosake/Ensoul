import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { userDataPath } from './paths';
import type { PythonEnvironmentRef } from '../shared/types';

interface EnvironmentConfig {
  pythons?: PythonEnvironmentRef[];
  activePythonId?: string;
  migratedWorkspaces?: string[];
  mirror?: string;
  customPypi?: string;
  customNpm?: string;
  [key: string]: unknown;
}

function readConfig(file: string): EnvironmentConfig {
  if (!fs.existsSync(file)) return {};
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('运行环境配置格式不正确');
  return value as EnvironmentConfig;
}

export function environmentRoot(dataDirectory = userDataPath('')): string {
  return path.join(dataDirectory, 'env');
}

export function environmentDirectory(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error('环境名称无效');
  return path.join(environmentRoot(), name);
}

export function environmentConfigFile(dataDirectory = userDataPath('')): string {
  return path.join(dataDirectory, 'env-config.json');
}

function writeConfig(file: string, config: EnvironmentConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

export function readEnvironmentConfig(workspace = '', dataDirectory = userDataPath('')): EnvironmentConfig {
  const file = environmentConfigFile(dataDirectory);
  const current = readConfig(file);
  const legacyFile = workspace ? path.join(workspace, '.ensoul', 'state', 'env-config.json') : '';
  if (!legacyFile || current.migratedWorkspaces?.includes(workspace) || !fs.existsSync(legacyFile)) return current;
  const legacy = readConfig(legacyFile);
  const pythons = [...current.pythons || []];
  for (const python of legacy.pythons || []) {
    if (pythons.some(item => item.path === python.path)) continue;
    const id = pythons.some(item => item.id === python.id) ? `${python.id}-${createHash('sha256').update(python.path).digest('hex').slice(0, 8)}` : python.id;
    pythons.push({ ...python, id });
  }
  const merged = { ...legacy, ...current, pythons, migratedWorkspaces: [...current.migratedWorkspaces || [], workspace] };
  writeConfig(file, merged);
  return merged;
}

export function registerPythonEnvironment(record: PythonEnvironmentRef, workspace = '', dataDirectory = userDataPath('')): void {
  if (!record.id || !record.name || !record.path) throw new Error('解释器登记信息不完整');
  const config = readEnvironmentConfig(workspace, dataDirectory);
  const pythons = [...config.pythons || []];
  const index = pythons.findIndex(item => item.id === record.id || item.path === record.path);
  if (index >= 0) pythons[index] = { ...pythons[index], ...record }; else pythons.push(record);
  writeConfig(environmentConfigFile(dataDirectory), { ...config, pythons });
}
