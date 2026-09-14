import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import { readSourceFile } from '../common/read-file';
import {
  detectFrameworks,
  firstParagraph,
  mostCommonLanguage,
  renderOverviewDigest,
  topLevelDirCounts,
  type OverviewFileEntry,
} from './overview-digest';

const README_RE = /^readme(\.md)?$/i;
const MAX_TOP_DIRS = 6;

interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

@Injectable()
export class RepoOverviewService {
  /**
   * Computed once per successful index from data IndexingService already has
   * in memory (the walked file list) plus two single-file reads
   * (package.json, README) — deliberately not a third full tree walk.
   */
  async generate(
    workspacePath: string,
    fallbackName: string,
    files: OverviewFileEntry[],
  ): Promise<string> {
    const { name, scripts, frameworks } = await this.readPackageJson(
      workspacePath,
      fallbackName,
    );
    const readmeExcerpt = await this.readReadmeExcerpt(workspacePath, files);

    return renderOverviewDigest({
      name,
      totalFiles: files.length,
      topLanguage: mostCommonLanguage(files),
      topDirs: topLevelDirCounts(files, MAX_TOP_DIRS),
      frameworks,
      scripts,
      readmeExcerpt,
    });
  }

  private async readPackageJson(
    workspacePath: string,
    fallbackName: string,
  ): Promise<{ name: string; scripts: string[]; frameworks: string[] }> {
    try {
      const { text } = await readSourceFile(
        path.join(workspacePath, 'package.json'),
      );
      const pkg = JSON.parse(text) as PackageJsonShape;
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      return {
        name: pkg.name ?? fallbackName,
        scripts: Object.keys(pkg.scripts ?? {}),
        frameworks: detectFrameworks(dependencies),
      };
    } catch {
      return { name: fallbackName, scripts: [], frameworks: [] };
    }
  }

  private async readReadmeExcerpt(
    workspacePath: string,
    files: OverviewFileEntry[],
  ): Promise<string | null> {
    const readmeEntry = files.find(
      (f) => !f.relPath.includes('/') && README_RE.test(f.relPath),
    );
    if (!readmeEntry) return null;

    try {
      const { text } = await readSourceFile(
        path.join(workspacePath, readmeEntry.relPath),
      );
      return firstParagraph(text);
    } catch {
      return null;
    }
  }
}
