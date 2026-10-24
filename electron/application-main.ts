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
import { installApplicationPermissions } from './platform/security/session-permissions.js';
import { installRendererContentSecurity } from './platform/security/renderer-csp.js';
import path from 'path';
import { registerProfileIPC, ensureDefaultProfiles, } from './browser/profile-store.js';
import { registerBlockRulesIPC, ensureDefaultBlockRules, } from './store/block-rules-store.js';
import { registerPresetsIPC, ensureDefaultPresets, } from './browser/preset-store.js';
import { registerPdfProtocol } from './browser/pdf-protocol.js';
import { setCloudPcHotkeyManager, isCloudPc } from './utils/cloud-pc.js';
import { setBrowserHotkeyFallback, tryForward, matchBrowserHotkeyFallback } from './utils/browser-hotkey-fallback.js';
import { registerAppSettingsIPC, getAppSettings, applyAutoLaunchSetting, updateAppSettings } from './store/app-settings-store.js';
import { setNativeThemeSource } from './theme/native-theme-source.js';
import { seedFromInstallConfig } from './store/install-config-seed.js';
import { registerProxyAuthHandler } from './store/proxy-helper.js';
import { initChatStore, getChatStore, closeChatStore } from './store/chat-store.js';
import { isImportingData } from './store/import-guard.js';
import { registerBaseChatIpc, registerUsageTraceIpc } from './store/chat-ipc.js';
import { hasActiveAssetStreams } from './assets/asset-stream-activity.js';
import { registerNavHistoryIpc } from './ipc/nav-history-ipc.js';
import { WindowManager } from './platform/window/containers/profile-window.js';
import { FingerprintEngine } from './browser/fingerprint.js';
import { HotkeyManager } from './platform/hotkey/manager.js';
import { SttEngine } from './modules/plugins/voice/stt/engine.js';
import { IPC_CHANNELS } from './shared/types.js';
import { registerWindowControlIpc } from './ipc/window-control-ipc.js';
import { installWebviewFocusTracking } from './browser/webview-focus.js';
// 必须在任何 webview 加载前注册：guest preload 会 sendSync 上报焦点，
// 主进程若尚未监听会永久阻塞渲染进程（页面白屏）。
installWebviewFocusTracking();
import { registerTabIpc } from './browser/tab-ipc.js';
import { registerAccumulatedLinksIpc } from './ipc/accumulated-links-ipc.js';
import { registerHotkeyIpc } from './ipc/hotkey-ipc.js';
import { registerSettingsIpc } from './ipc/settings-ipc.js';
import { registerApplicationUpdates } from './updates/host.js';
import { registerOnboardingIpc } from './ipc/onboarding-ipc.js';
import { promptAccessibilityPermission } from './utils/permission-manager.js';
import { registerPlatformInfoIPC } from './utils/platform-info.js';
import { registerRuntimeProcessesIPC } from './diagnostics/runtime-processes.js';
import { registerTabHibernationIPC } from './browser/tab-hibernate-store.js';
import { createResidentMemoryMonitor } from './diagnostics/resident-memory-monitor.js';
import { registerTabProcessPriorityIPC, forgetWindow as forgetPriorityWindow } from './diagnostics/tab-process-priority.js';
import { EffectScope } from './modules/effect-scope.js';
import { attachDownloadHandlersForAllProfiles, maybeAutoCleanCache, hasActiveDownloads } from './browser/download-handler.js';
import { sweepStaleRuntimeTemp } from './utils/temp-hygiene.js';
import { windowState } from './platform/window/window-state.js';
import { windowStore } from './store/window-store.js';
import { isTrackedFullscreen } from './utils/fullscreen-tracker.js';
import { createMainWindow, createBrowserWindow, createChatWindow, showHistoryWindow, showPromptWindow, showAiAppEditorWindow, showSettingsWindow, showHistoryDownloadWindow, openAdvancedPanelWindow, toggleAdvancedPanelWindow, showOnboardingWindow, setOnboardingLifecycleCallbacks, getSenderWindow, findWindowIdByWin, } from './window-factory.js';
import { initAppFocusTracker } from './modules/plugins/voice/preview-window.js';
import { warmWin32ForegroundBridge } from './utils/win32-foreground.js';
import { peekSttEngine, startBackgroundVoiceGated, stopBackgroundVoiceGated, toggleVoiceRecordingGated, } from './modules/plugins/voice/index.js';
import { createTray, hasTray } from './platform/window/tray.js';
import { cleanupOnQuit, runUiohookHealthCheck } from './lifecycle.js';
import { BUILTIN_MODULES } from './modules/manifests.js';
import { initEnabledModules, registerModule, isModuleEnabled } from './modules/registry.js';
import { registerModuleIpc } from './ipc/module-ipc.js';
import { closeModuleStateDb } from './store/module-state-store.js';
import { closeAssetCollectionJournal, stopAssetRetention, hasWebOriginalTransfers } from './assets/asset-ipc.js';
import { hasLinkedOriginalTransfers } from './assets/api-originals.js';
import { hasActiveAssetImports } from './assets/import-activity.js';
import { hasActiveBackupExports } from './store/backup-activity.js';
import { hasActiveBackupOperations } from './store/backup/activity.js';
import { registerVoiceConfigIPC } from './voice-config-ipc.js';
import { registerAIProviderIPC } from './store/ai-provider-store.js';
import { registerPromptIPC } from './modules/plugins/prompt-library/prompt-store.js';
import { registerNotesAssetProtocol } from './modules/plugins/notes/notes-asset-store.js';
import { registerWhiteboardAssetProtocol } from './modules/plugins/whiteboard/whiteboard-asset-store.js';
import { setRuntimeLogLevel } from './diagnostics/application-log.js';
import { isRemoteNavigationAllowed, isTrustedRendererUrl } from './platform/security/trusted-renderer.js';
import { installBrowserDomainPorts } from './browser/ports.js';
const DEFAULT_MAIN_WINDOW_WIDTH = 420;
const DEFAULT_MAIN_WINDOW_HEIGHT = 820;
/** 应用自身的特权 scheme：will-navigate 守卫放行这些内部协议的页面导航 */
const INTERNAL_NAVIGATION_SCHEMES = new Set(['sidekickai', 'sidekick-pdf', 'whiteboard-asset', 'notes-asset', 'devtools', 'about']);
const __dirname = path.dirname(__filename);
// 浏览器域实现必须先于任何窗口创建注入 L1 端口
installBrowserDomainPorts();
process.on('unhandledRejection', (reason) => {
    console.error('[main] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[main] Uncaught Exception:', err);
});
let fingerprintEngine: FingerprintEngine;
let hotkeyManager: HotkeyManager;
/** 休眠快照保留清理器：应用退出前停止定时器 */
/** 内存预算监控器：应用退出前停止定时器 */
let residentMemoryMonitor: ReturnType<typeof createResidentMemoryMonitor> | undefined;
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
    // 预热前台窗口读写桥（常驻 PowerShell 会话），让首次热键唤出避开 Add-Type 冷启动
    warmWin32ForegroundBridge();
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
    // Config facade stays available while voice/tts are disabled; claim it under a non-module owner.
    registerVoiceConfigIPC(new EffectScope('voice-config', 'voice-config'));
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
    ipcMain.handle(IPC_CHANNELS.SETTINGS_WINDOW_OPEN, (_e, category?: import('./shared/api/settings-options.js').SettingsCategory) => {
        showSettingsWindow(category);
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
        // 启动即恢复应用内主题（nativeTheme.themeSource），webview 内 AI 应用不依赖首个窗口上报
        setNativeThemeSource(settings.themeMode);
    }
    catch (e) {
        console.warn('[main] 同步自启动设置失败:', e);
    }
    // Attach before the first window loads so even early autoplay is observed.
    residentMemoryMonitor = createResidentMemoryMonitor(() => {
      if (isImportingData || hasActiveDownloads() || hasActiveAssetStreams()
        || hasActiveAssetImports() || hasActiveBackupExports() || hasActiveBackupOperations()
        || hasWebOriginalTransfers() || hasLinkedOriginalTransfers()) return true;
      const preview = windowState.previewWindow;
      if (preview && !preview.isDestroyed() && preview.isVisible()) return true;
      return BrowserWindow.getAllWindows().some(win => {
        if (win.isDestroyed()) return false;
        const id = findWindowIdByWin(win);
        return isCloudPc(win.webContents.id) || win.isFullScreen() || (id ? isTrackedFullscreen(id) : false);
      });
    }, () => getAppSettings().lowMemoryMode === true);
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
        // 统一经焦点服务唤出（采集本轮归还目标 + 代际管理），不走裸 show/focus
        void Promise.resolve(applicationFocus.show(win)).then(() => {
            if (!win.isDestroyed())
                win.webContents.send(IPC_CHANNELS.WINDOW_SHOWN);
        });
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
    void sweepStaleRuntimeTemp(app.getPath('temp')).catch(error => console.warn('[temp] sweep failed:', error));
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
    registerTabProcessPriorityIPC();
    registerTabHibernationIPC(new EffectScope('tab-hibernation', 'tab-hibernation'));
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
    // 网络边界（启动期全局强制，网站侧不可更改）：内嵌 AI 页面（webview）及其弹窗、
    // 独立浏览器窗等所有应用内 webContents 的 WebRTC 一律只允许默认公网接口绑定，
    // 不触碰局域网/内网接口，避免实时语音/视频创建预期外的 UDP 监听并触发
    // Windows 防火墙网络弹窗；覆盖所有 profile 会话，不响应网站侧的任何申请。
    try {
        contents.setWebRTCIPHandlingPolicy('default_public_interface_only');
        if (contents.getWebRTCIPHandlingPolicy() !== 'default_public_interface_only') {
            throw new Error('策略读取校验不一致');
        }
    } catch (error) {
        console.error('[network-boundary] WebRTC 策略设置失败，该内容可能触发网络弹窗:', error);
    }
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
    residentMemoryMonitor?.stop();
    closeAssetCollectionJournal();
    closeChatStore();
    closeModuleStateDb();
});
