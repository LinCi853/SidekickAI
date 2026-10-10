import { startEditionSession, markEditionReady, bindEditionActivation } from './edition-runtime.js';
import { activateApplicationWindow, isApplicationWindowLoading } from './application-activation.js';
import * as applicationFocus from './utils/focus-manager.js';
import { exportCliRequestPath, startupRestore } from './runtime-environment.js';
import { restoreBackupCookies } from '../packages/backup-core/sessions.js';
import { finishPendingRestore, requestRestoreRollback } from '../packages/backup-core/transaction.js';
import { parseBackupManifest } from '../packages/backup-core/format.js';
import { readFileSync } from 'node:fs';
import { app, BrowserWindow, Menu, ipcMain, protocol, screen, session, dialog } from 'electron';
import { allowWhiteboardClipboard } from './assets/whiteboard-clipboard.js';
import { installApplicationPermissions } from './security/session-permissions.js';
import { installRendererContentSecurity } from './security/renderer-csp.js';
import path from 'path';
import { registerProfileIPC, ensureDefaultProfiles, } from './store/profile-store.js';
import { registerBlockRulesIPC, ensureDefaultBlockRules, } from './store/block-rules-store.js';
import { registerPresetsIPC, ensureDefaultPresets, } from './store/preset-store.js';
import { registerPdfProtocol } from './utils/pdf-protocol.js';
import { setCloudPcHotkeyManager, isCloudPc } from './utils/cloud-pc.js';
import { setBrowserHotkeyFallback, tryForward, matchBrowserHotkeyFallback } from './utils/browser-hotkey-fallback.js';
import { registerAppSettingsIPC, getAppSettings, applyAutoLaunchSetting, updateAppSettings } from './store/app-settings-store.js';
import { seedFromInstallConfig } from './store/install-config-seed.js';
import { registerProxyAuthHandler } from './store/proxy-helper.js';
import { initChatStore, getChatStore, closeChatStore } from './store/chat-store.js';
import { isImportingData } from './store/import-guard.js';
import { registerBaseChatIpc, registerUsageTraceIpc } from './ai/handler.js';
import { registerNavHistoryIpc } from './ipc/nav-history-ipc.js';
import { WindowManager } from './window/manager.js';
import { FingerprintEngine } from './fingerprint/engine.js';
import { HotkeyManager } from './hotkey/manager.js';
import { SttEngine } from './stt/engine.js';
import { IPC_CHANNELS } from './shared/types.js';
import { registerWindowControlIpc } from './ipc/window-control-ipc.js';
import { registerTabIpc } from './ipc/tab-ipc.js';
import { registerAccumulatedLinksIpc } from './ipc/accumulated-links-ipc.js';
import { registerHotkeyIpc } from './ipc/hotkey-ipc.js';
import { registerSettingsIpc } from './ipc/settings-ipc.js';
import { registerApplicationUpdates } from './updates/host.js';
import { registerOnboardingIpc } from './ipc/onboarding-ipc.js';
import { promptAccessibilityPermission } from './utils/permission-manager.js';
import { registerPlatformInfoIPC } from './utils/platform-info.js';
import { registerRuntimeProcessesIPC } from './diagnostics/runtime-processes.js';
import { attachDownloadHandlersForAllProfiles, maybeAutoCleanCache } from './utils/download-handler.js';
import { windowState } from './window-state.js';
import { windowStore } from './store/window-store.js';
import { isTrackedFullscreen } from './utils/fullscreen-tracker.js';
import { createMainWindow, createBrowserWindow, createChatWindow, showHistoryWindow, showPromptWindow, showAiAppEditorWindow, showSettingsWindow, showHistoryDownloadWindow, openAdvancedPanelWindow, toggleAdvancedPanelWindow, showOnboardingWindow, setOnboardingLifecycleCallbacks, getSenderWindow, findWindowIdByWin, } from './window-factory.js';
import { initAppFocusTracker } from './voice/preview-window.js';
import { peekSttEngine, startBackgroundVoiceGated, stopBackgroundVoiceGated, toggleVoiceRecordingGated, } from './modules/wiring/voice.js';
import { createTray, hasTray } from './window/tray.js';
import { cleanupOnQuit, runUiohookHealthCheck } from './lifecycle.js';
import { BUILTIN_MODULES } from './modules/manifests.js';
import { initEnabledModules, registerModule, isModuleEnabled } from './modules/registry.js';
import { registerModuleIpc } from './ipc/module-ipc.js';
import { closeModuleStateDb } from './store/module-state-store.js';
import { closeAssetCollectionJournal, stopAssetRetention } from './assets/asset-ipc.js';
import { registerVoiceConfigIPC } from './store/voice-store.js';
import { registerAIProviderIPC } from './store/ai-provider-store.js';
import { registerPromptIPC } from './store/prompt-store.js';
import { registerNotesAssetProtocol } from './store/notes-asset-store.js';
import { registerWhiteboardAssetProtocol } from './store/whiteboard-asset-store.js';
import { setRuntimeLogLevel } from './diagnostics/application-log.js';
import { isRemoteNavigationAllowed, isTrustedRendererUrl } from './security/trusted-renderer.js';
const DEFAULT_MAIN_WINDOW_WIDTH = 420;
const DEFAULT_MAIN_WINDOW_HEIGHT = 820;
/** 应用自身的特权 scheme：will-navigate 守卫放行这些内部协议的页面导航 */
const INTERNAL_NAVIGATION_SCHEMES = new Set(['sidekickai', 'sidekick-pdf', 'whiteboard-asset', 'notes-asset', 'devtools', 'about']);
const __dirname = path.dirname(__filename);
process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[main] Uncaught Exception:', err);
});
let fingerprintEngine: FingerprintEngine;
let hotkeyManager: HotkeyManager;
app.whenReady().then(async () => {
    if (startupRestore.error) {
        dialog.showErrorBox('应用数据操作未完成', startupRestore.error);
    }
    if (startupRestore.restored) {
        let skippedItems = 0;
        const root = app.getPath('userData');
        try {
            const manifest = parseBackupManifest(JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')));
            const { restoreBackupDrafts } = await import('../packages/backup-core/sensitive-drafts.js');
            const drafts = restoreBackupDrafts(root, manifest.sensitiveDrafts);
            skippedItems = drafts.unavailable + (manifest.importReport?.skipped.length ?? 0);
            await restoreBackupCookies(root, manifest.cookieSnapshots);
            finishPendingRestore(root);
        }
        catch (error) {
            try {
                requestRestoreRollback(root);
                console.warn('[backup] Import was rejected; restoring the previous data', error);
                app.relaunch();
            } catch (rollbackError) {
                dialog.showErrorBox('应用数据恢复失败', '自动恢复暂未完成，请重新启动应用。\n' + (rollbackError as Error).message);
            }
            app.exit(1);
            return;
        }
        if (skippedItems) await dialog.showMessageBox({ type: 'info', title: '导入完成', message: `数据已恢复，${skippedItems} 项不可用内容已跳过。`, buttons: ['确定'] }).catch(error => console.warn('[backup] Import notice could not be displayed', error));
    }
    if (exportCliRequestPath) {
        try {
            const { runExportCli } = await import('./store/export-cli.js');
            const code = await runExportCli(exportCliRequestPath);
            app.exit(code);
        }
        catch (err) {
            console.error('[main] export CLI failed:', err);
            app.exit(1);
        }
        return;
    }
    if (!await startEditionSession('concept', () => isImportingData))
        return;
    Menu.setApplicationMenu(null);
    seedFromInstallConfig();
    // settings.db 损坏或原生模块加载失败时降级为默认日志级别继续启动：
    // 后续 getAppSettings 调用点均已各自降级，不能让这里成为启动的中断点
    try {
        setRuntimeLogLevel(getAppSettings().logLevel);
    }
    catch (err) {
        console.error('[main] 读取应用设置失败，使用默认日志级别继续启动:', err);
    }
    const autoOpenDevTools = process.argv.includes('--dev-tools') || process.env.DEV_TOOLS === '1';
    if (autoOpenDevTools) {
        console.log('[main] DevTools 调试模式：新窗口将自动打开 DevTools');
        windowState.autoOpenDevTools = true;
    }
    const silentStartRequested = process.argv.includes('--hidden');
    const showGuideRequested = process.argv.includes('--show-guide');
    const skipGuideRequested = process.argv.includes('--skip-guide');
    initAppFocusTracker();
    installRendererContentSecurity(session.defaultSession);
    installApplicationPermissions(session.defaultSession, (contents, permission, details) =>
        allowWhiteboardClipboard({ permission, senderId: contents.id, hostId: windowState.advancedPanelWindow?.webContents.id,
            hostUrl: contents.getURL(), requestingUrl: details.requestingUrl ?? '', isMainFrame: details.isMainFrame,
            enabled: isModuleEnabled('whiteboard') }));
    fingerprintEngine = new FingerprintEngine();
    const windowManager = new WindowManager(fingerprintEngine);
    windowState.windowManager = windowManager;
    hotkeyManager = new HotkeyManager();
    setCloudPcHotkeyManager(hotkeyManager);
    setBrowserHotkeyFallback((e) => {
        const action = matchBrowserHotkeyFallback(e);
        if (!action)
            return;
        let browserWin: Electron.BrowserWindow | null = null;
        for (const win of windowState.browserWindowsByProfile.values()) {
            if (win && !win.isDestroyed() && win.isFocused()) {
                browserWin = win;
                break;
            }
        }
        if (!browserWin)
            return;
        const win = browserWin;
        if (action === 'toggleCloudPc') {
            if (tryForward('toggleCloudPc', win.webContents)) {
                console.log('[hotkey-fallback] Ctrl+Alt+C → 切换云电脑模式 (uiohook)');
                win.webContents.send(IPC_CHANNELS.WEBVIEW_HOTKEY, { action: 'toggleCloudPc' });
            }
            return;
        }
        if (isCloudPc(win.webContents.id))
            return;
        if (action === 'toggleFullscreen') {
            if (tryForward('toggleFullscreen', win.webContents)) {
                const wid = findWindowIdByWin(win);
                const wasFs = wid ? isTrackedFullscreen(wid) : win.isFullScreen();
                console.log('[hotkey-fallback] F11 → 切换沉浸式全屏 (uiohook), wasFullScreen=', wasFs);
                if (!wasFs) {
                    if (wid) {
                        const state = windowStore.getOrDefault(wid);
                        state.fullscreenNormalBounds = win.getBounds();
                        windowStore.save(wid, state);
                    }
                }
                try {
                    win.setFullScreen(!wasFs);
                }
                catch { }
            }
            return;
        }
    });
    setOnboardingLifecycleCallbacks({
        onShow: () => hotkeyManager.pauseAllShortcuts(),
        onClose: () => hotkeyManager.resumeAllShortcuts(),
    });
    if (process.platform === 'darwin') {
        promptAccessibilityPermission().then((granted) => {
            if (!granted) {
                console.warn('[main] macOS 辅助功能权限未授权，uiohook 将不可用，降级为仅 globalShortcut');
            }
        });
    }
    try {
        initChatStore();
        try {
            if (getAppSettings().usageTrackingEnabled) {
                getChatStore().logAppStart();
            }
        }
        catch (e) {
            console.warn('[main] logAppStart 失败:', e);
        }
    }
    catch (err) {
        console.error('[main] initChatStore 失败，对话持久化功能将不可用:', err);
    }
    BUILTIN_MODULES.forEach((m) => registerModule(m));
    registerModuleIpc();
    registerVoiceConfigIPC();
    registerNotesAssetProtocol();
    registerWhiteboardAssetProtocol();
    await initEnabledModules();
    if (!isModuleEnabled('custom-chat')) {
        registerAIProviderIPC();
    }
    if (!isModuleEnabled('prompt-library')) {
        registerPromptIPC();
    }
    ensureDefaultProfiles();
    registerBlockRulesIPC();
    ensureDefaultBlockRules();
    ipcMain.handle(IPC_CHANNELS.AI_APP_EDITOR_OPEN, (_e, opts: {
        platformId?: string;
        profileId?: string;
        mode?: 'edit' | 'create';
    }) => {
        if (!opts || typeof opts !== 'object')
            return;
        showAiAppEditorWindow(opts);
    });
    ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_OPEN, () => {
        showSettingsWindow();
    });
    ipcMain.handle(IPC_CHANNELS.ADVANCED_PANEL_OPEN, (_e, providerId?: string) => {
        openAdvancedPanelWindow(providerId ? { providerId, initialTab: 'chat' } : undefined);
    });
    ipcMain.handle(IPC_CHANNELS.ADVANCED_PANEL_TOGGLE, () => {
        toggleAdvancedPanelWindow();
    });
    registerPresetsIPC();
    ensureDefaultPresets();
    try {
        const settings = getAppSettings();
        applyAutoLaunchSetting(settings.autoLaunch, settings.silentStart);
    }
    catch (e) {
        console.warn('[main] 同步自启动设置失败:', e);
    }
    createMainWindow();
    try {
        const mw = windowState.mainWindow;
        if (mw && !mw.isDestroyed()) {
            const sendType = () => {
                try {
                    mw.webContents.send(IPC_CHANNELS.SET_WINDOW_TYPE, 'main');
                }
                catch { }
            };
            if (mw.webContents.isLoading()) {
                mw.webContents.once('did-finish-load', sendType);
            }
            else {
                sendType();
            }
        }
    }
    catch { }
    createTray();
    let pendingOnboarding = showGuideRequested;
    try {
        if (!pendingOnboarding && !skipGuideRequested && !silentStartRequested) {
            pendingOnboarding = !getAppSettings().onboardingCompleted;
        }
        if (skipGuideRequested && !getAppSettings().onboardingCompleted) {
            updateAppSettings({ onboardingCompleted: true });
        }
    }
    catch (e) {
        console.warn('[main] 读取 onboardingCompleted 失败，跳过引导:', e);
    }
    if (pendingOnboarding && windowState.mainWindow) {
        const mw = windowState.mainWindow;
        mw.hide();
        mw.once('ready-to-show', () => mw.hide());
        showOnboardingWindow();
    }
    else if (silentStartRequested && windowState.mainWindow) {
        const mw = windowState.mainWindow;
        if (windowState.trayEnabled) {
            mw.hide();
            mw.once('ready-to-show', () => mw.hide());
        }
        else {
            console.warn('[main] 静默启动请求但托盘未创建，降级为显示主窗口');
        }
    }
    registerOnboardingIpc();
    screen.on('display-metrics-changed', (_e, display, _changedMetrics) => {
        try {
            const targetDisplay = display;
            for (const win of BrowserWindow.getAllWindows()) {
                if (win.isDestroyed())
                    continue;
                const winBounds = win.getBounds();
                const matched = screen.getDisplayMatching(winBounds);
                if (matched.id === targetDisplay.id) {
                    console.log(`[main] display-metrics-changed: window=${win.id} scaleFactor=${targetDisplay.scaleFactor || 1}（不再重设 zoomFactor，由 CSS 令牌控制 UI 比例）`);
                }
            }
        }
        catch (err) {
            console.error('[main] display-metrics-changed 处理失败:', err);
        }
    });
    app.on('second-instance', () => {
        const win = windowState.mainWindow;
        if (!win || win.isDestroyed()) {
            createMainWindow();
            return;
        }
        if (win.isMinimized())
            win.restore();
        win.setSkipTaskbar(false);
        if (!win.isVisible())
            win.show();
        win.focus();
        win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN);
    });
    registerProfileIPC();
    registerBaseChatIpc();
    registerNavHistoryIpc();
    registerUsageTraceIpc();
    registerPdfProtocol();
    registerAppSettingsIPC(async (target, options, encrypt) => {
      const { exportApplicationData } = await import('./store/backup-recovery.js');
      return exportApplicationData(target, options, encrypt);
    });
    attachDownloadHandlersForAllProfiles();
    void maybeAutoCleanCache();
    registerProxyAuthHandler();
    registerWindowControlIpc({
        windowManager,
        fingerprintEngine,
        getSenderWindow,
        findWindowIdByWin,
        createChatWindow,
        showHistoryWindow,
    });
    registerTabIpc({
        windowManager,
        getSenderWindow,
        findWindowIdByWin,
        createBrowserWindow,
    });
    registerAccumulatedLinksIpc();
    registerSettingsIpc();
    registerApplicationUpdates();
    registerPlatformInfoIPC();
    registerRuntimeProcessesIPC();
    registerHotkeyIpc({
        hotkeyManager,
        getMainWindow: () => windowState.mainWindow,
        toggleAdvancedPanelWindow,
        startBackgroundVoice: startBackgroundVoiceGated,
        stopBackgroundVoice: stopBackgroundVoiceGated,
        toggleVoiceRecording: toggleVoiceRecordingGated,
    });
    runUiohookHealthCheck(hotkeyManager);
    bindEditionActivation(() => activateApplicationWindow({ current: () => windowState.mainWindow, create: createMainWindow, show: applicationFocus.show }), () => isApplicationWindowLoading(windowState.mainWindow));
    markEditionReady();
    void import('./store/backup-recovery.js').then(({ resumeBackupRecovery }) => resumeBackupRecovery()).catch(error => console.error('[backup] Recovery status failed', error));
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createMainWindow();
        }
    });
}).catch((err) => {
    // 兜底必须退出进程：只打日志会把"启动中断但进程存活"变成无窗口、无托盘、
    // 无法退出的僵尸应用（用户只能任务管理器杀进程）。
    console.error('[main] app.whenReady() 失败:', err);
    try {
        dialog.showErrorBox('应用启动失败', `初始化过程中出现错误，应用即将退出。\n${err instanceof Error ? err.message : String(err)}`);
    }
    catch { /* dialog 不可用时保留日志即可 */ }
    app.exit(1);
});
app.on('window-all-closed', () => {
    if (hasTray())
        return;
    if (isImportingData)
        return;
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
app.on('web-contents-created', (_event, contents) => {
    contents.on('will-prevent-unload', (event) => {
        queueMicrotask(() => {
            if (!event.defaultPrevented)
                (app as unknown as {
                    isQuitting: boolean;
                }).isQuitting = false;
        });
    });
    // 页面发起的顶层导航只允许留在本应用文档或内部特权 scheme；一旦渲染层出现
    // 意外导航（XSS、错误 loadURL），不能让带着完整 IPC 面的页面运行在不可信内容上。
    // webview guest 与登记过豁免的独立弹窗（OAuth/登录、Ctrl+click）不受此守卫约束。
    contents.on('will-navigate', (event, url) => {
        if (contents.getType() !== 'window' || isRemoteNavigationAllowed(contents)) return;
        if (isTrustedRendererUrl(url)) return;
        try {
            const scheme = new URL(url).protocol.slice(0, -1);
            if (INTERNAL_NAVIGATION_SCHEMES.has(scheme)) return;
        }
        catch { /* URL 解析失败视为不可信 */ }
        console.warn('[main] 已拦截应用窗口的页面导航:', url);
        event.preventDefault();
    });
});
app.on('before-quit', (event) => {
    if (event.defaultPrevented || isImportingData) {
        event.preventDefault();
        return;
    }
    ;
    (app as unknown as {
        isQuitting: boolean;
    }).isQuitting = true;
});
app.on('will-quit', () => {
    cleanupOnQuit({ hotkeyManager, sttEngine: peekSttEngine() });
    stopAssetRetention();
    closeAssetCollectionJournal();
    closeChatStore();
    closeModuleStateDb();
});
