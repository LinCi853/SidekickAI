// electron/headless/browser-manager.ts
// 无头浏览器管理器（puppeteer-core + Electron 自带 Chromium）
//
// 设计目标：
// - 单例管理浏览器实例，按需启动/关闭
// - 复用 Electron 自带的 Chromium，不额外下载
// - 提供页面池、截图、自动化操作等基础能力
// - 主进程运行，通过 IPC 暴露给渲染层
// - 为后续自动化测试、网页抓取、智能操作等功能提供内核支撑

import puppeteer, {
  Browser,
  Page,
  LaunchOptions,
} from 'puppeteer-core';
import { app } from 'electron';
import * as path from 'node:path';

export interface ScreenshotResult {
  ok: boolean;
  data?: string;
  filePath?: string;
  error?: string;
}

export interface PageInfo {
  id: string;
  url: string;
  title: string;
}

export interface NavigateResult {
  ok: boolean;
  title?: string;
  error?: string;
}

/**
 * 无头浏览器管理器（单例）
 *
 * 特性：
 * - 懒启动：首次调用时才启动浏览器
 * - 页面池：限制最大页面数，复用空闲页面
 * - 自动清理：空闲超时后关闭页面，应用退出时关闭浏览器
 * - 复用 Electron Chromium：不额外下载，体积最小
 */
class HeadlessBrowserManager {
  private browser: Browser | null = null;
  private pages: Map<string, Page> = new Map();
  private pageIdCounter = 0;
  private launchPromise: Promise<Browser> | null = null;
  private maxPages = 10;

  /** 获取 Electron 自带 Chromium 的可执行文件路径 */
  private getChromiumPath(): string {
    // Electron 打包后，Chromium 在应用内
    if (app.isPackaged) {
      // Windows: resources/electron.asar 同级的 chrome.exe
      // macOS: 应用包内的 Chromium Framework
      const basePath = path.dirname(app.getPath('exe'));
      if (process.platform === 'win32') {
        return path.join(basePath, 'chrome.exe');
      }
    }
    // 开发模式：使用 electron 包内置的 Chromium
    // 路径形如 node_modules/electron/dist/chrome.exe (win) 或 Electron.app (mac)
    // puppeteer-core 可通过 executablePath 指定
    const electronPath = require('electron') as typeof import('electron');
    // 在 Electron 主进程中，app.getPath('exe') 返回的是 Electron 可执行文件
    // 对于 puppeteer，我们直接用 Electron 自己的可执行路径
    return app.getPath('exe');
  }

  /** 获取默认启动参数 */
  private getLaunchOptions(): LaunchOptions {
    return {
      executablePath: this.getChromiumPath(),
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--ignore-certificate-errors',
      ],
      defaultViewport: {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
      },
    };
  }

  /** 启动浏览器（懒加载，并发安全） */
  async launch(): Promise<Browser> {
    if (this.browser && this.browser.connected) {
      return this.browser;
    }
    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      const options = this.getLaunchOptions();
      console.log('[HeadlessBrowser] 启动浏览器:', options.executablePath);
      const browser = await puppeteer.launch(options);

      browser.on('disconnected', () => {
        console.log('[HeadlessBrowser] 浏览器已断开');
        this.browser = null;
        this.pages.clear();
      });

      this.browser = browser;
      this.launchPromise = null;
      console.log('[HeadlessBrowser] 浏览器启动成功');
      return browser;
    })();

    return this.launchPromise;
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.pages.clear();
      console.log('[HeadlessBrowser] 浏览器已关闭');
    }
  }

  /** 浏览器是否运行中 */
  isRunning(): boolean {
    return this.browser !== null && this.browser.connected;
  }

  /** 创建新页面 */
  async createPage(url?: string): Promise<string> {
    const browser = await this.launch();

    if (this.pages.size >= this.maxPages) {
      throw new Error(`已达到最大页面数限制 (${this.maxPages})`);
    }

    const page = await browser.newPage();
    const pageId = `page_${++this.pageIdCounter}`;
    this.pages.set(pageId, page);

    page.on('close', () => {
      this.pages.delete(pageId);
    });

    if (url) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        console.warn('[HeadlessBrowser] 页面导航失败:', url, e);
      }
    }

    return pageId;
  }

  /** 关闭页面 */
  async closePage(pageId: string): Promise<boolean> {
    const page = this.pages.get(pageId);
    if (!page) return false;
    try {
      await page.close();
    } catch {
      // ignore
    }
    this.pages.delete(pageId);
    return true;
  }

  /** 获取页面（内部使用） */
  private getPage(pageId: string): Page {
    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`页面不存在: ${pageId}`);
    }
    return page;
  }

  /** 导航到指定 URL */
  async navigate(pageId: string, url: string): Promise<NavigateResult> {
    try {
      const page = this.getPage(pageId);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const title = await page.title();
      return { ok: true, title };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 获取页面信息 */
  async getPageInfo(pageId: string): Promise<PageInfo | null> {
    try {
      const page = this.getPage(pageId);
      const url = page.url();
      const title = await page.title();
      return { id: pageId, url, title };
    } catch {
      return null;
    }
  }

  /** 截图（base64 或保存到文件） */
  async screenshot(
    pageId: string,
    options: { fullPage?: boolean; saveToFile?: string } = {},
  ): Promise<ScreenshotResult> {
    try {
      const page = this.getPage(pageId);
      const { saveToFile, fullPage } = options;

      if (saveToFile) {
        await page.screenshot({
          type: 'png',
          fullPage: fullPage ?? false,
          path: saveToFile,
        });
        return { ok: true, filePath: saveToFile };
      }

      const result = await page.screenshot({
        type: 'png',
        fullPage: fullPage ?? false,
        encoding: 'base64',
      });
      return { ok: true, data: String(result) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 导出 PDF */
  async pdf(pageId: string): Promise<ScreenshotResult> {
    try {
      const page = this.getPage(pageId);
      const buffer = (await page.pdf()) as unknown as Uint8Array;
      return { ok: true, data: Buffer.from(buffer).toString('base64') };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * 在页面上执行 JavaScript 代码。
   *
   * 安全说明：这是无头浏览器自动化能力的预期设计（等同于 puppeteer page.evaluate）。
   * 调用方（headless/ipc.ts）必须校验调用者身份与 script 来源，仅允许可信上下文调用，
   * 避免渲染层任意脚本注入无头浏览器页面执行。
   */
  async evaluate(pageId: string, script: string): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      const page = this.getPage(pageId);
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${script} })()`);
      const result = await page.evaluate(fn as () => unknown);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 获取所有页面 ID */
  listPages(): string[] {
    return Array.from(this.pages.keys());
  }

  /** 获取浏览器版本信息 */
  async version(): Promise<string> {
    const browser = await this.launch();
    return browser.version();
  }

  /** 设置最大页面数 */
  setMaxPages(max: number): void {
    this.maxPages = max;
  }
}

export const headlessBrowser = new HeadlessBrowserManager();

export default headlessBrowser;
