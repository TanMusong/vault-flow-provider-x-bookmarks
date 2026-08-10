import type { VaultProvider, ProviderContext, DownloadFile, TaskResult, AddTaskParams, AddTaskResponse, ProviderResult } from '@vault-flow/provider-api';
import { MediaType, FileStatus, DownloadStatus } from '@vault-flow/provider-api';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer-core';
import { TwitterItem, TwitterApiResponse, parseApiResponse, getMediaUrls } from './api';
import { BOOKMARKS_URL, UnbookmarkResult, unbookmarkPage } from './actions';

puppeteer.use(StealthPlugin());

export class XBookmarksProvider implements VaultProvider {
  constructor() {}

  private async checkLogin(ctx: ProviderContext, page: Page, timeout = 60000): Promise<{ username: string; userId: string }> {
    let username = '', userId = '';
    try {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle2', timeout });
      for (let i = 0; i < 10; i++) {
        const result = await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
          if (!btn) return { name: '', id: '' };
          const nameImg = btn.querySelector('img[alt]');
          const name = nameImg?.getAttribute('alt') || '';
          let displayName = name;
          if (!displayName) {
            const avatarDiv = btn.querySelector('div[aria-label]');
            displayName = avatarDiv?.getAttribute('aria-label') || '';
          }
          let handle = '';
          const allSpans = btn.querySelectorAll('span');
          for (const s of allSpans) {
            if (s.textContent?.startsWith('@')) {
              handle = s.textContent.replace(/^@/, '');
              break;
            }
          }
          if (!handle) {
            const handleSpan = btn.querySelector('span[class*="r-16dba41"]');
            handle = handleSpan?.textContent?.replace(/^@/, '') || '';
          }
          return { name: displayName, id: handle };
        });
        if (result.id) { username = result.name || result.id; userId = result.id; break; }
        await new Promise<void>(r => setTimeout(r, 1000));
      }
      if (!userId) {
        const fallback = await page.evaluate(() => {
          const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
          if (profileLink) {
            const href = (profileLink.getAttribute('href') || '').replace(/^\//, '');
            if (href && !href.startsWith('i/')) return href;
          }
          return '';
        });
        if (fallback) { username = fallback; userId = fallback; }
      }
    } catch (err) {
      console.error('[twitter] checkLogin error:', (err as Error).message);
    }
    return { username, userId };
  }

  private async launchBrowser(ctx: ProviderContext, cookies?: string): Promise<{ browser: Browser; page: Page }> {
    const cookieStr = cookies || ctx.storage.get('cookies') as string | undefined;
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }) as Browser;
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    if (cookieStr) {
      const cookieList = cookieStr.split(';').map(c => c.trim()).filter(Boolean).map(c => {
        const [name, ...rest] = c.split('=');
        return { name: name.trim(), value: rest.join('='), domain: '.x.com', path: '/' };
      });
      await page.setCookie(...cookieList);
    }
    return { browser, page };
  }

  async addTask(ctx: ProviderContext, params: AddTaskParams): Promise<AddTaskResponse> {
    let browser: Browser | null = null;
    try {
      const cookies = params.cookies as string | undefined;
      if (!cookies) {
        return { success: false, message: 'Cookie is required' };
      }
      const { browser: b, page } = await this.launchBrowser(ctx, cookies);
      browser = b;
      const { username, userId } = await this.checkLogin(ctx, page);
      await page.close().catch(() => {});
      if (!userId) {
        return { success: false, message: 'X login check failed - could not detect user' };
      }
      ctx.storage.set('cookies', cookies);
      return { success: true, name: username };
    } catch (err) {
      return { success: false, message: (err as Error).message.slice(0, 100) };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  async deleteTask(ctx: ProviderContext, taskId: string): Promise<ProviderResult> {
    if (ctx.hasPostDownloadRecord(taskId)) {
      return { success: false, message: 'Cannot delete task with existing downloads' };
    }
    return { success: true };
  }

  private async fetchItems(page: Page, skipIds?: string[], timeout = 60000): Promise<{ items: TwitterItem[]; cursor: string | null }> {
    let allItems: TwitterItem[] = [];
    let lastCursor: string | null = null;

    const responseHandler = async (res: import('puppeteer-core').HTTPResponse) => {
      const url = res.url();
      if (!url.includes('Bookmarks')) return;
      try {
        const text = await res.text();
        let parsed: TwitterApiResponse | null = null;
        try { parsed = JSON.parse(text); } catch (_e) {
          const match = text.match(/=\s*({.+})\s*;?\s*$/s);
          if (match) { try { parsed = JSON.parse(match[1]); } catch (_e2) { /* */ } }
        }
        if (!parsed?.data?.bookmark_timeline_v2?.timeline?.instructions?.length) return;
        for (const item of parseApiResponse(parsed)) {
          if (!allItems.find(x => x.id === item.id)) allItems.push(item);
        }
        for (const inst of parsed.data.bookmark_timeline_v2.timeline.instructions) {
          const entries = inst.entries || [];
          const lastEntry = entries[entries.length - 1];
          if (lastEntry?.entryId?.startsWith('cursor-bottom')) {
            lastCursor = (lastEntry.content as { value?: string })?.value || null;
          }
        }
      } catch (_e) { /* */ }
    };

    page.on('response', responseHandler);
    try {
      await page.goto(BOOKMARKS_URL, { waitUntil: 'networkidle2', timeout });
      for (let i = 0; i < 30 && allItems.length === 0; i++) {
        await new Promise<void>(r => setTimeout(r, 1000));
      }
      const filtered = allItems.filter(item => !skipIds || skipIds.indexOf(item.id) < 0);
      console.log(`[twitter] fetchItems: ${allItems.length} total, ${filtered.length} after filter`);
      return { items: filtered, cursor: lastCursor };
    } finally {
      page.off('response', responseHandler);
    }
  }

  async executeTask(ctx: ProviderContext): Promise<TaskResult> {
    const startTime = Date.now();
    console.log(`[twitter] executeTask: ${ctx.taskId}`);

    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      const cookies = ctx.storage.get('cookies') as string | undefined;
      const launched = await this.launchBrowser(ctx);
      browser = launched.browser;
      page = launched.page;

      const { username } = await this.checkLogin(ctx, page);
      if (!username) {
        ctx.addLog('warn', 'X login expired - checkLogin returned empty username');
        return { state: 2, message: 'status.login_expired', downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
      }
      ctx.addLog('info', `X login OK: ${username}`);

      let downloaded = 0, failed = 0;
      const skipIds: string[] = [];

      const handleUnbookmark = async (item: TwitterItem) => {
        const actionPage = await browser!.newPage();
        await actionPage.setViewport({ width: 1280, height: 800 });
        let result: UnbookmarkResult = { ok: false, reason: 'unknown' };
        try {
          result = await unbookmarkPage(actionPage, item.detailUrl);
        } catch (err) {
          result = { ok: false, reason: 'exception', detail: (err as Error).message };
        } finally {
          await actionPage.close().catch(() => {});
        }
        if (!result.ok) {
          const detailInfo = result.detail ? ` | detail: ${result.detail}` : '';
          ctx.addLog('warn', `Unbookmark failed: ${item.id} (${item.authorId}) | reason: ${result.reason}${detailInfo}`);
        }
      };

      const processItem = async (item: TwitterItem): Promise<void> => {
        skipIds.push(item.id);
        if (ctx.hasSuccessfulDownloadRecord(item.id)) {
          if (item.bookmarked) await handleUnbookmark(item);
          return;
        }
        const mediaUrls = getMediaUrls(item);
        if (mediaUrls.length === 0) {
          ctx.addLog('info', `No media: ${item.id} (${item.authorId})`);
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Success, stateMessage: 'status.no_media',
            files: [{ type: MediaType.Text, filename: 'status.no_media', url: '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Success }],
            dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          if (item.bookmarked) await handleUnbookmark(item);
          return;
        }
        try {
          const files: DownloadFile[] = [];
          const userDir = ctx.path.join(ctx.downloadDir, 'x', username, `${item.authorId || 'unknown'}_${item.author || 'unknown'}`);
          if (!ctx.fs.existsSync(userDir)) ctx.fs.mkdirSync(userDir, { recursive: true });
          for (const dl of mediaUrls) {
            files.push({ type: dl.type, filename: dl.filename, url: dl.urls[0] || '', fileSize: 0, fileExpectedSize: 0, fileStatus: FileStatus.Downloading });
          }
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Downloading, stateMessage: '',
            files, dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          await Promise.all(mediaUrls.map(async (dl, fi) => {
            const dest = ctx.path.join(userDir, dl.filename);
            for (const url of dl.urls) {
              try {
                const resp = await fetch(url, {
                  headers: { 'Cookie': cookies || '', 'Referer': 'https://x.com/' },
                });
                if (!resp.ok) continue;
                const buffer = Buffer.from(await resp.arrayBuffer());
                ctx.fs.writeFileSync(dest, buffer as unknown as string);
                const fileSize = buffer.length;
                files[fi].fileSize = fileSize;
                files[fi].fileExpectedSize = fileSize;
                files[fi].url = url;
                files[fi].fileStatus = FileStatus.Success;
                ctx.updateDownloadRecord(item.id, { files });
                return;
              } catch (_e) {
                continue;
              }
            }
            files[fi].fileStatus = FileStatus.Failed;
            ctx.updateDownloadRecord(item.id, { files });
          }));
          const allSuccess = files.length > 0 && files.every(f => f.fileStatus === FileStatus.Success);
          if (allSuccess) {
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Success, stateMessage: '', files });
            ctx.addLog('info', `Downloaded: ${item.author} (${item.authorId})/${item.id} | ${files.length} files`);
            downloaded++;
            if (item.bookmarked) await handleUnbookmark(item);
          } else {
            const failedFiles = files.filter(f => f.fileStatus !== FileStatus.Success).map(f => `${f.filename}(${f.fileStatus})`).join(', ');
            ctx.updateDownloadRecord(item.id, { state: DownloadStatus.Failed, stateMessage: `partial: ${failedFiles}`, files });
            ctx.addLog('warn', `Partial download failed: ${item.id} (${item.authorId}) | failed files: ${failedFiles}`);
            failed++;
          }
        } catch (err) {
          console.error('[twitter] download error:', (err as Error).message);
          ctx.addLog('error', `Download error: ${item.id} - ${(err as Error).message}`);
          ctx.addDownloadRecord({
            id: item.id, author: item.author, authorId: item.authorId, desc: item.desc,
            state: DownloadStatus.Failed, stateMessage: (err as Error).message.slice(0, 50),
            files: [], dataJson: { detailUrl: item.detailUrl, raw: item.raw }
          });
          failed++;
        }
      };

      let fetched: { items: TwitterItem[]; cursor: string | null };
      let maxRequestCount = 10;
      let processedCount = 0;

      do {
        fetched = await this.fetchItems(page, skipIds);
        maxRequestCount--;
        for (const item of fetched.items) {
          await processItem(item);
        }
        processedCount += fetched.items.length;
        ctx.emitTaskProgress(processedCount, processedCount);
      } while (fetched.items.length > 0 && maxRequestCount > 0);

      return {
        state: 1,
        message: 'ok',
        downloaded, failed,
        total: downloaded + failed,
        duration: Date.now() - startTime
      };
    } catch (err) {
      ctx.addLog('error', `X task error: ${(err as Error).message}`);
      return { state: 0, message: (err as Error).message, downloaded: 0, failed: 0, total: 0, duration: Date.now() - startTime };
    } finally {
      if (page) await page.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
}
