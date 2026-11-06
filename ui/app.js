// The real UI. magpie's launcher frame navigates here with the per-process
// token written into index.html; every request carries that token back.
// There is no fake state: everything shown comes from /api/bootstrap.

import {
  createConfirmController,
  createRequestGuard,
  formatAddress,
  normalizeProxyForm,
  proxyFingerprint,
  statusView,
} from "./proxy-state.js";
import { distinctRegions, filterProxies } from "./proxy-filter.js";
import { isScoreActive, isScoreSettled, scoreView } from "./proxy-score.js";
import {
  PLUGIN_SCAN_POLL_INTERVAL_MS,
  PLUGIN_SCAN_POLL_MAX_ATTEMPTS,
  localizedText,
  methodCategory,
  methodCategoryText,
  partitionProviders,
  providerCanSignIn,
  providerStatusView,
  shouldPollPluginScan,
} from "./provider-state.js";
import { signInActive, signInPayload } from "./signin-state.js";
import {
  accountCheckPath,
  accountIdentityPath,
  accountIdentityView,
  accountLabel,
  defaultAccountKey,
  retiredAccounts,
} from "./account-state.js";
import {
  accountView,
  filterAccounts,
  formatCheckSummary,
  formatExit,
  sortAccounts,
} from "./account-view.js";
import {
  environmentPercent,
  environmentPhase,
  formatBytes,
} from "./environment-state.js";
import { createReloadGuard } from "./reload-guard.js";

const TOKEN_HEADER = "x-clean-login-token";

// One automatic reload per document lifecycle. The guard counts across
// documents through a URL marker; without it a still-mismatched token would
// reload the page forever against the loopback service.
const reloadGuard = createReloadGuard({ location: globalThis.location, history: globalThis.history });

const messages = {
  en: {
    title: "msg",
    subtitle: "Proxy exits, isolated sign-ins, one account ledger.",
    providers: "Providers",
    proxies: "Proxy IPs",
    providersTitle: "Providers",
    providersCopy: "Supported providers and their current sign-in readiness.",
    providersEmptyTitle: "No providers yet",
    providersEmptyCopy: "Supported providers appear here when the local service is ready.",
    providersMoreTitle: "Other subscription providers",
    providersMoreHint: "Every other subscription service the local data knows about: magpie's own providers, and the plugins written for magpie and checked against its built-in sign-in.",
    providerPending: "Pending verification",
    providerReady: "Ready",
    providerBlocked: "Blocked",
    providersSourceMagpie: "List derived from magpie",
    providersSourceLocal: "magpie list unavailable · using the local list",
    providersDiff: "{both} in both · {localOnly} only local · {magpieOnly} only in magpie",
    providersDiffNone: "The local list matches magpie.",
    providersDiffUnavailable: "magpie's provider list could not be read, so differences cannot be shown.",
    providerMethodsHeading: "Sign-in methods found in installed plugins",
    providerMethodBrowserTag: "browser",
    providerMethodDeviceTag: "device code",
    providerMethodFormTag: "needs details",
    providerMethodLocalTag: "local session",
    providerMethodKeyTag: "key",
    providerMethodSecretTag: "paste a token",
    providerMethodPendingTag: "way to confirm",
    providerMethodUnknownTag: "way to confirm",
    providerMethodNote: "The sign-in way is confirmed when the sign-in starts; the page it opens is the source of truth.",
    providerSourceLineHeading: "List source",
    providerSourceLocal: "local registry",
    providerSourceMagpie: "magpie list",
    providerSourcePlugins: "installed plugin",
    providerPluginsFound: "{count} installed provider entries · {browser} need a browser",
    providerPluginsScanning: "Scanning installed plugins…",
    providerPluginsUnavailable: "Installed plugin scan unavailable",
    providerPluginsFailed: "Installed plugin scan failed: {error}",
    providerPluginsScanTimedOut: "The installed-plugin scan is still running. Reload the page to see its result.",
    addAccount: "Add account",
    reportIssue: "Report a problem",
    reportTitle: "Report a problem",
    reportCopy: "The text is already written for you. One click opens GitHub's new-issue page in your browser with the title and body filled in; you only press Create.",
    reportNoteLabel: "Anything to add? (optional)",
    reportNoteHint: "What you saw, what you clicked, what happened. You can leave this empty.",
    reportDraftLabel: "What will be posted",
    reportDraftHint: "No account, cookie, token or proxy credential is included.",
    reportOpen: "Open on GitHub",
    reportCopyBody: "Copy text",
    reportCancel: "Cancel",
    reportPreparing: "Writing the report…",
    reportOpened: "Opened in your browser with the title and body filled in. Press Create to post it.",
    reportCopied: "The text is on your clipboard.",
    reportCopyFailed: "Copying was blocked. Select the text above and copy it by hand.",
    reportBuildFailed: "The report could not be prepared.",
    signInTitle: "Add account",
    signInCopy: "This opens an isolated browser window. Complete the sign-in there; msg writes the resulting credential into magpie.",
    signInUnverified: "This flow has not been verified in msg yet. You can try it directly; failures are reported honestly and feedback is welcome.",
    signInProxyLabel: "Proxy IP",
    signInProxyDirect: "No proxy (direct)",
    signInMethodLabel: "Sign-in method",
    signInMethodHint: "This provider offers several sign-in methods. Pick the one you want; the wrong one signs you in to the wrong site.",
    signInStart: "Start sign-in",
    signInStarting: "Starting…",
    signInOpened: "The sign-in page is open in an isolated browser window. Please complete the sign-in in that window.",
    signInNavigationWarning: "The browser is open, but the page did not finish loading in time. You can still complete sign-in manually in the open window.",
    signInCancel: "Cancel sign-in",
    signInClose: "Close",
    signInStateAuthorizing: "Authorizing…",
    signInStateWaiting: "Waiting for you to finish in the browser…",
    signInStateFinishing: "Writing the credential into magpie…",
    signInStateDone: "Done",
    signInStateError: "Failed",
    signInStateCancelled: "Cancelled",
    signInAccountKey: "Account key",
    signInAccountLabel: "Continue with an existing identity",
    signInAccountHint: "This identity keeps its own browser fingerprint. Continuing reuses it instead of drawing a new one.",
    signInAccountNew: "New account (new fingerprint)",
    signInDone: "Signed in. The credential was written to magpie.",
    signInCancelled: "The sign-in was cancelled.",
    signInBusy: "A sign-in is already in progress.",
    identitiesTitle: "Account identities",
    identitiesCopy: "Each account keeps its own browser fingerprint. A signed-out identity is kept, so signing in again reuses the same fingerprint instead of drawing a new one.",
    identitiesEmpty: "No signed-out identities yet.",
    identitiesLastSignedIn: "Last signed in {time}",
    identitiesClear: "Clear identity",
    identitiesClearing: "Clearing…",
    identitiesCleared: "The identity was cleared.",
    identitiesClearTitle: "Clear this identity?",
    identitiesClearCopy: "The kept browser fingerprint and profile of “{name}” are deleted. The next sign-in for that account draws a new fingerprint.",
    identitiesClearConfirm: "Clear identity",
    identitiesError: "The identities could not be loaded.",
    identitiesLoading: "Reading the kept identities…",
    identitiesRetry: "Retry",
    environmentTitle: "Login browser setup",
    environmentCopy: "msg needs a one-time isolated browser so sign-in pages never open in your everyday browser. Nothing is downloaded until you choose Prepare.",
    environmentSizeLabel: "Download",
    environmentSizeValue: "{size} download · about {extracted} on disk",
    environmentDiskLabel: "Free disk space",
    environmentDiskValue: "{free} free · {required} needed",
    environmentLocationLabel: "Install location",
    environmentNote: "The browser files stay inside this plugin's own cache, never your shared Camoufox cache.",
    environmentChecksumVerified: "The download is verified against the published sha256.",
    environmentChecksumUnverified: "The download is not checksum-verified because a custom browser URL was set without a sha256.",
    environmentBadgeMissing: "Not installed",
    environmentBadgeReady: "Ready",
    environmentBadgePreparing: "Preparing…",
    environmentBadgeError: "Setup failed",
    environmentBadgeCancelled: "Cancelled",
    environmentProgress: "{percent}% · {received} of {total}",
    environmentPrepare: "Prepare browser",
    environmentCancel: "Cancel",
    environmentRetry: "Retry",
    errorInsufficientDisk: "Not enough free disk space to install the login browser.",
    errorInstallerUnavailable: "The browser runtime is not available in this installation.",
    errorDownloadFailed: "The browser download failed.",
    errorRateLimited: "GitHub rate-limited the download. Set GITHUB_TOKEN or the browser URL override, then retry.",
    errorExtractFailed: "The browser archive could not be unpacked.",
    errorEnvironmentUnknown: "The browser setup failed.",
    proxiesTitle: "Proxy IPs",
    proxiesCopy: "Each account signs in and makes requests through the proxy you choose.",
    proxiesEmptyTitle: "No proxy IPs yet",
    proxiesEmptyCopy: "Add a proxy to give providers a clean exit.",
    addProxy: "Add Proxy",
    connecting: "Connecting…",
    ready: "Local service connected",
    failed: "Local service unavailable",
    retry: "Retry",
    name: "Name",
    type: "Type",
    host: "Host",
    port: "Port",
    username: "Username",
    password: "Password",
    optional: "(optional)",
    addProxyTitle: "Add Proxy IP",
    editProxyTitle: "Edit Proxy IP",
    proxyDialogCopy: "HTTP, HTTPS and SOCKS5 are supported. Passwords are stored locally and never shown again.",
    namePlaceholder: "Singapore · 01",
    hostPlaceholder: "127.0.0.1",
    portPlaceholder: "1080",
    passwordKeepHint: "The password is saved. Leave this blank to keep it.",
    testConnection: "Test connection",
    testing: "Testing…",
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    close: "Close",
    statusUntested: "Never tested",
    statusTesting: "Testing…",
    statusOk: "Available",
    statusError: "Failed",
    never: "Never",
    unknown: "Unknown",
    lastChecked: "Last checked",
    exitIp: "Exit IP",
    colName: "Name",
    colAddress: "Address",
    colRegion: "Region",
    colStatus: "Status",
    colChecked: "Last checked",
    colScore: "Score",
    scoreAction: "Score",
    scoring: "Scoring…",
    scoreFailed: "Score failed",
    scoreBusy: "A score is already in progress.",
    scoreStateLaunching: "Opening the browser…",
    scoreStateMeasuring: "Reading the Trust Score…",
    scoreStateDone: "Score saved.",
    scoreStateError: "Score failed",
    scoreNavigationFailed: "The scoring browser opened, but the page did not finish loading. Complete the check in the open window or try again.",
    scoreStateCancelled: "Scoring cancelled.",
    scoreCancel: "Close window",
    filterRegionLabel: "Region",
    filterAllRegions: "All",
    filterLatencyLabel: "Latency (ms)",
    filterLatencyMin: "Min",
    filterLatencyMax: "Max",
    filterReset: "Reset",
    filterCount: "Showing {shown} / {total}",
    filterNoMatch: "No proxies match these filters.",
    regionUntested: "Untested",
    test: "Test",
    edit: "Edit",
    delete: "Delete",
    deleteTitle: "Delete proxy IP?",
    deleteCopy: "Remove “{name}” from the proxy list? This cannot be undone.",
    deleteConfirm: "Delete",
    testSuccess: "Connection works · exit {ip} · {region} · {latency} ms",
    testFailure: "Connection failed · {error}",
    nameRequired: "Enter a name.",
    nameInvalid: "The name contains unsupported characters.",
    nameTooLong: "The name is too long.",
    typeInvalid: "Choose HTTP, HTTPS or SOCKS5.",
    hostRequired: "Enter a host.",
    hostInvalid: "Enter a host without spaces or control characters.",
    hostTooLong: "The host is too long.",
    portInvalid: "The port must be between 1 and 65535.",
    usernameInvalid: "The username contains unsupported characters.",
    usernameTooLong: "The username is too long.",
    passwordInvalid: "The password contains unsupported characters.",
    passwordTooLong: "The password is too long.",
    errorInvalidName: "Enter a name.",
    errorInvalidType: "Choose HTTP, HTTPS or SOCKS5.",
    errorInvalidHost: "Enter a valid host.",
    errorInvalidPort: "The port must be between 1 and 65535.",
    errorInvalidUsername: "The username is not valid.",
    errorInvalidPassword: "The password is not valid.",
    errorNotFound: "This proxy no longer exists.",
    errorInvalidJson: "The request was not valid JSON.",
    errorTooLarge: "The request was too large.",
    errorUnauthorized: "The local service token is no longer valid. Reload the page.",
    errorForbidden: "The local service refused the request.",
    errorInternal: "The local service could not complete this request.",
    errorAccountNotFound: "This identity no longer exists.",
    errorAccountSignedIn: "This account is still signed in. Sign it out in magpie first.",
    errorAccountAuthUnreadable: "The signed-in accounts could not be read, so nothing was changed.",
    errorAccountInvalid: "This identity reference is not valid.",
    errorAccountRetiredMissing: "This identity no longer exists for the provider.",
    errorAccountMismatch: "The sign-in returned a different account than the chosen identity, so nothing was written.",
    errorNetwork: "The local service could not be reached.",
    errorGeneric: "The request failed.",
    testTimeout: "Connection timed out.",
    testRefused: "The proxy refused the connection.",
    testDns: "The proxy host could not be resolved.",
    testReset: "The proxy closed the connection.",
    testProxyAuth: "Proxy authentication failed.",
    testTunnel: "The proxy refused the tunnel.",
    testEndpointHttp: "The test endpoint returned an HTTP error.",
    testEndpointJson: "The test endpoint did not return usable JSON.",
    testTls: "Secure connection to the test endpoint failed.",
    testSocksAuth: "SOCKS5 authentication failed.",
    testSocksRefused: "The SOCKS5 proxy refused the connection.",
    testSocksHost: "The SOCKS5 proxy could not reach the test endpoint.",
    testSocksGeneral: "The SOCKS5 proxy could not connect.",
    testUnknown: "Could not reach the test endpoint through this proxy.",
    accounts: "Accounts",
    accountsTitle: "Accounts",
    accountsCopy: "Every account used with msg, its pinned browser fingerprint, and who.1ms.dog's verdict on that identity.",
    accountsRefresh: "Refresh",
    accountsRefreshing: "Refreshing…",
    accountsRefreshed: "Read {count} accounts.",
    accountSearchLabel: "Search accounts",
    accountSearchPlaceholder: "Search accounts",
    accountSortLabel: "Sort",
    accountSortLastLogin: "Recent login",
    accountSortName: "Account name",
    accountSortProvider: "Provider",
    accountSortGrade: "Check grade",
    accountFilterLabel: "Status",
    accountFilterAll: "All",
    accountFilterSignedIn: "Signed in",
    accountFilterSignedOut: "Signed out",
    accountFilterCount: "Showing {shown} / {total}",
    accountEmpty: "No accounts yet",
    accountEmptyCopy: "Accounts appear here after a sign-in through msg.",
    accountNoMatch: "No accounts match these filters.",
    accountColName: "Account",
    accountColFingerprint: "Fingerprint",
    accountColLastLogin: "Last login",
    accountColCheck: "Identity check",
    accountColStatus: "Status",
    accountColActions: "Actions",
    accountUnverified: "Unverified flow",
    accountUnverifiedTitle: "This account came from a sign-in flow that has not been verified in msg yet.",
    accountSignedIn: "Signed in",
    accountSignedOut: "Signed out · identity kept",
    accountCheckNone: "Not checked",
    accountChecking: "Checking…",
    accountFingerprintPinned: "Pinned {time}",
    accountFingerprintNone: "No pinned fingerprint",
    accountExitDirect: "Direct",
    accountLastLoginAt: "{time} · {exit}",
    accountCheckExposure: "{count} places may expose you",
    accountRelogin: "Sign in again",
    accountReloginTitle: "Reuse this account's kept fingerprint instead of drawing a new one.",
    accountCheck: "Check",
    accountDetail: "Details",
    accountClear: "Clear identity",
    accountCheckBusy: "A check is already in progress.",
    gradeLegendLabel: "Verdict",
    gradeA: "Clean · ready to use",
    gradeB: "Usable · some traces",
    gradeC: "Change the exit",
    gradeD: "Do not use this exit",
    gradeDisclaimer: "This is a verdict from the third-party site who.1ms.dog. It is not a provider risk-control conclusion, and it is not a fingerprint score of our own.",
    gradeMeaningA: "Clean: the exit and identity agree, safe to use.",
    gradeMeaningB: "Usable: the site can see a proxy, but nothing contradicts itself.",
    gradeMeaningC: "Change the exit: identity and exit disagree. Try another exit.",
    gradeMeaningD: "Do not use this exit: several contradictions. Change the exit first.",
    accountDetailTitle: "Account",
    accountDetailProvider: "Provider",
    accountDetailKey: "Account key",
    accountDetailFingerprint: "Fingerprint id",
    accountDetailPinnedAt: "Pinned at",
    accountDetailLastLoginExit: "Last login exit",
    accountDetailStatus: "Status",
    accountDetailNote: "Note",
    accountDetailNoteSave: "Save note",
    accountDetailNoteSaving: "Saving…",
    accountDetailNoteHint: "Only the note is stored on this account, up to 200 characters.",
    accountDetailNoteEmpty: "No note yet.",
    accountDetailSaved: "The note was saved.",
    accountDetailNoteTooLong: "The note is too long.",
    accountDetailSigninHint: "This account is still signed in. Sign it out in magpie before clearing its identity.",
    accountDetailRetiredHint: "The fingerprint and the account's profile live together: unless you clear the identity, signing in again reuses the same fingerprint.",
    accountDetailHistoryTitle: "Check history",
    accountDetailHistoryEmpty: "Not checked yet. A check opens who.1ms.dog with this identity.",
    accountDetailHistoryLine: "{grade} · {time} · {exit} · {exposure} exposures",
    accountDetailDismiss: "Close",
    accountCheckFailedExit: "Exit: {exit}",
    accountCheckTitle: "Identity check",
    accountCheckCopy: "Opens who.1ms.dog with this account's own browser fingerprint and reads back the site's verdict.",
    accountCheckProxyLabel: "Proxy IP",
    accountCheckProxyDirect: "No proxy (direct)",
    accountCheckProxyHint: "The exit used at sign-in is not recorded; this check uses the exit you select here.",
    accountCheckTargetLabel: "Target site",
    accountCheckEtaLabel: "Expected time",
    accountCheckEtaValue: "As reported by the site",
    accountCheckExitLabel: "Exit",
    accountCheckTimeLabel: "Time",
    accountCheckGradeLabel: "Grade",
    accountCheckIdentityLabel: "Identity used",
    accountCheckNote: "The site cannot be embedded. msg opens an isolated window, reads the verdict, then closes it.",
    accountCheckStart: "Start check",
    accountCheckRunningOpening: "Opening the isolated browser…",
    accountCheckRunningReading: "Reading the site's verdict…",
    accountCheckElapsed: "{seconds}s",
    accountCheckCancel: "Cancel check",
    accountCheckCancelled: "The check was cancelled. No verdict was produced.",
    accountCheckSummary: "who.1ms.dog verdict · exit {exit} · {time}",
    accountCheckNoExposure: "The site flagged no contradictions",
    accountCheckResultNote: "The verdict is stored on this account only; it is not sent anywhere else.",
    accountCheckAgain: "Check again",
    accountCheckReexit: "Check with another exit",
    accountCheckDetails: "Details",
    accountCheckFailedTitle: "The check did not finish",
    accountCheckFailedDetail: "{reason} (exit: {exit})",
    accountCheckFailedNoVerdict: "This check did not finish, so no new verdict was produced.",
    accountCheckFailedKeepPrevious: "The previous verdict is still {grade} · {time} ({exit}); nothing changed.",
    accountCheckFailedNoPrevious: "This account has no verdict record yet.",
    accountCheckRetry: "Retry",
    accountCheckChangeExit: "Choose another exit",
    accountCheckDismiss: "Close",
    checkErrorBrowserMissing: "The isolated browser is missing. Prepare the login browser first.",
    checkErrorExecutableMissing: "The browser executable is missing. Re-prepare the login browser.",
    checkErrorIdentityMissing: "This account has no pinned fingerprint yet, so the check could not start.",
    checkErrorLaunchFailed: "The isolated browser did not start. The install directory may be in use or a file may be missing.",
    checkErrorLaunchTimeout: "The isolated browser took too long to start.",
    checkErrorPageTimeout: "who.1ms.dog did not return a verdict in time. The site may be slow or the exit may have swallowed the request.",
    checkErrorVerdictMissing: "who.1ms.dog did not return a verdict this time.",
    checkErrorCancelled: "The check was cancelled, so it produced no verdict.",
    checkErrorProxyNotFound: "The selected proxy no longer exists. Choose another exit.",
    checkErrorAccountNotFound: "This account no longer exists. Refresh the list.",
    checkErrorCheckBusy: "A check is already in progress. Wait for it to finish.",
    checkErrorInternal: "The local service could not complete this check.",
    checkErrorUnknown: "The check stopped before it produced a verdict.",
    errorInvalidNote: "The note is not valid.",
    toastNoteSaved: "The note was saved.",
    toastCheckDone: "Check finished · grade {grade}.",
    toastCheckCancelled: "The check was cancelled.",
    toastRefreshed: "Accounts refreshed.",
  },
  "zh-Hans": {
    title: "msg",
    subtitle: "代理出口、隔离登录与账号账本，一处管好。",
    providers: "供应商",
    proxies: "代理 IP",
    providersTitle: "供应商",
    providersCopy: "受支持的供应商及其当前的登录就绪状态。",
    providersEmptyTitle: "还没有供应商",
    providersEmptyCopy: "本地服务就绪后，支持的供应商会显示在这里。",
    providersMoreTitle: "其他订阅类供应商",
    providersMoreHint: "其余订阅类供应商都在这里：magpie 自带的，以及为 magpie 编写、对照过内置登录的插件。",
    providerPending: "等待验证",
    providerReady: "就绪",
    providerBlocked: "已阻止",
    providersSourceMagpie: "名单来自 magpie",
    providersSourceLocal: "未取得 magpie 名单 · 使用本地名单",
    providersDiff: "两边都有 {both} · 仅本地 {localOnly} · 仅 magpie {magpieOnly}",
    providersDiffNone: "本地名单与 magpie 一致。",
    providersDiffUnavailable: "无法读取 magpie 的供应商名单，因此无法显示差异。",
    providerMethodsHeading: "已安装插件中找到的登录方式",
    providerMethodBrowserTag: "浏览器",
    providerMethodDeviceTag: "设备码",
    providerMethodFormTag: "需要填表",
    providerMethodLocalTag: "本地登录态",
    providerMethodKeyTag: "密钥",
    providerMethodSecretTag: "粘贴密钥",
    providerMethodPendingTag: "方式待确认",
    providerMethodUnknownTag: "方式待确认",
    providerMethodNote: "登录方式在开始登录时才会确认，以实际打开的页面为准。",
    providerSourceLineHeading: "名单来源",
    providerSourceLocal: "本地注册表",
    providerSourceMagpie: "magpie 名单",
    providerSourcePlugins: "已安装插件",
    providerPluginsFound: "已安装供应商条目 {count} 个 · {browser} 个需要浏览器",
    providerPluginsScanning: "正在扫描已安装插件…",
    providerPluginsUnavailable: "无法扫描已安装插件",
    providerPluginsFailed: "已安装插件扫描失败：{error}",
    providerPluginsScanTimedOut: "已安装插件扫描仍在进行。刷新页面以查看结果。",
    addAccount: "添加账号",
    reportIssue: "报告问题",
    reportTitle: "报告问题",
    reportCopy: "正文已经帮你写好了。点一下就会用系统默认浏览器打开 GitHub 的新建 issue 页面，标题和正文都填好，你只要再点 Create 就发出去了。",
    reportNoteLabel: "补充说明（可选）",
    reportNoteHint: "写下你看到的现象、点过的按钮、实际结果。留空也能直接发。",
    reportDraftLabel: "将要提交的内容",
    reportDraftHint: "内容不含账号、cookie、令牌或代理凭据。",
    reportOpen: "在浏览器中打开",
    reportCopyBody: "复制正文",
    reportCancel: "取消",
    reportPreparing: "正在准备正文…",
    reportOpened: "已在浏览器中打开，标题和正文都填好了，点一下 Create 就发出去了。",
    reportCopied: "正文已复制。",
    reportCopyFailed: "复制被拦住了，请手动选中上面的正文再复制。",
    reportBuildFailed: "没能生成报告正文。",
    signInTitle: "添加账号",
    signInCopy: "这会打开一个隔离浏览器窗口。请在窗口里完成登录，msg会把生成的凭据写入 magpie。",
    signInUnverified: "该流程还没有在msg中验证过。你可以直接尝试，失败会如实报错，也欢迎反馈问题。",
    signInProxyLabel: "代理 IP",
    signInProxyDirect: "不使用代理（直连）",
    signInMethodLabel: "登录方式",
    signInMethodHint: "该供应商提供了多个登录方式，请选择你要用的那一个；选错会登录到错误的站点。",
    signInStart: "开始登录",
    signInStarting: "正在开始…",
    signInOpened: "已在隔离浏览器窗口打开登录页，请在那个窗口里完成登录。",
    signInNavigationWarning: "浏览器已打开，但页面未在限定时间内加载完成。你仍可以在已打开的窗口里手动完成登录。",
    signInCancel: "取消登录",
    signInClose: "关闭",
    signInStateAuthorizing: "正在获取登录地址…",
    signInStateWaiting: "等待你在浏览器窗口中完成登录…",
    signInStateFinishing: "正在把凭据写入 magpie…",
    signInStateDone: "已完成",
    signInStateError: "失败",
    signInStateCancelled: "已取消",
    signInAccountKey: "账号键",
    signInAccountLabel: "沿用已有身份继续登录",
    signInAccountHint: "该身份保留自己的浏览器指纹。沿用时会重用该指纹，而不是重新生成。",
    signInAccountNew: "新账号（新的指纹）",
    signInDone: "登录完成，凭据已写入 magpie。",
    signInCancelled: "登录已取消。",
    signInBusy: "已有登录正在进行。",
    identitiesTitle: "账号身份",
    identitiesCopy: "每个账号都有自己的浏览器指纹。已登出的身份会被保留，因此再次登录时会重用同一个指纹，而不是重新生成。",
    identitiesEmpty: "目前没有已登出的身份。",
    identitiesLastSignedIn: "上次登录于 {time}",
    identitiesClear: "清除身份",
    identitiesClearing: "清除中…",
    identitiesCleared: "身份已清除。",
    identitiesClearTitle: "清除这个身份？",
    identitiesClearCopy: "“{name}”保留的浏览器指纹与配置目录会被删除。该账号下次登录时会生成新的指纹。",
    identitiesClearConfirm: "清除身份",
    identitiesError: "无法加载身份列表。",
    identitiesLoading: "正在读取保留的身份…",
    identitiesRetry: "重试",
    environmentTitle: "登录浏览器设置",
    environmentCopy: "msg需要一次性准备一个隔离浏览器，登录页面不会出现在日常浏览器中。只有点击“准备”后才会开始下载。",
    environmentSizeLabel: "下载大小",
    environmentSizeValue: "下载 {size} · 磁盘占用约 {extracted}",
    environmentDiskLabel: "可用磁盘空间",
    environmentDiskValue: "可用 {free} · 需要 {required}",
    environmentLocationLabel: "安装位置",
    environmentNote: "浏览器文件保存在本插件自己的缓存中，不会写入你共享的 Camoufox 缓存。",
    environmentChecksumVerified: "下载已按公布的 sha256 校验。",
    environmentChecksumUnverified: "已覆盖浏览器 URL 且未提供 sha256，因此下载未做校验。",
    environmentBadgeMissing: "未安装",
    environmentBadgeReady: "已就绪",
    environmentBadgePreparing: "正在准备…",
    environmentBadgeError: "设置失败",
    environmentBadgeCancelled: "已取消",
    environmentProgress: "{percent}% · {received} / {total}",
    environmentPrepare: "准备浏览器",
    environmentCancel: "取消",
    environmentRetry: "重试",
    errorInsufficientDisk: "磁盘可用空间不足，无法安装登录浏览器。",
    errorInstallerUnavailable: "此安装中缺少浏览器运行时。",
    errorDownloadFailed: "浏览器下载失败。",
    errorRateLimited: "GitHub 对下载进行了限流。请设置 GITHUB_TOKEN 或浏览器 URL 覆盖后重试。",
    errorExtractFailed: "无法解压浏览器压缩包。",
    errorEnvironmentUnknown: "浏览器设置失败。",
    proxiesTitle: "代理 IP",
    proxiesCopy: "账号通过你选择的代理完成登录和后续请求。",
    proxiesEmptyTitle: "还没有代理 IP",
    proxiesEmptyCopy: "添加代理，为供应商提供干净的出口。",
    addProxy: "添加代理",
    connecting: "正在连接…",
    ready: "本地服务已连接",
    failed: "本地服务不可用",
    retry: "重试",
    name: "名称",
    type: "类型",
    host: "地址",
    port: "端口",
    username: "用户名",
    password: "密码",
    optional: "（可选）",
    addProxyTitle: "添加代理 IP",
    editProxyTitle: "编辑代理 IP",
    proxyDialogCopy: "支持 HTTP、HTTPS 和 SOCKS5。密码只保存在本机，之后不会再显示。",
    namePlaceholder: "新加坡 · 01",
    hostPlaceholder: "127.0.0.1",
    portPlaceholder: "1080",
    passwordKeepHint: "已保存密码。留空表示保持不变。",
    testConnection: "测试连接",
    testing: "正在测试…",
    save: "保存",
    saving: "正在保存…",
    cancel: "取消",
    close: "关闭",
    statusUntested: "未检测",
    statusTesting: "正在测试…",
    statusOk: "可用",
    statusError: "失败",
    never: "从未",
    unknown: "未知",
    lastChecked: "上次检测",
    exitIp: "出口 IP",
    colName: "名称",
    colAddress: "地址",
    colRegion: "地区",
    colStatus: "状态",
    colChecked: "上次检测",
    colScore: "评分",
    scoreAction: "评分",
    scoring: "评分中…",
    scoreFailed: "评分失败",
    scoreBusy: "已在评分中。",
    scoreStateLaunching: "正在打开浏览器…",
    scoreStateMeasuring: "正在读取 Trust Score…",
    scoreStateDone: "评分已保存。",
    scoreStateError: "评分失败",
    scoreNavigationFailed: "评分浏览器已打开，但页面未在限定时间内加载完成。可在已打开的窗口中完成检测，或稍后重试。",
    scoreStateCancelled: "评分已取消。",
    scoreCancel: "关闭窗口",
    filterRegionLabel: "地区",
    filterAllRegions: "全部",
    filterLatencyLabel: "延迟（毫秒）",
    filterLatencyMin: "最小",
    filterLatencyMax: "最大",
    filterReset: "重置",
    filterCount: "已筛选 {shown} / 共 {total}",
    filterNoMatch: "没有符合筛选条件的代理。",
    regionUntested: "未测试",
    test: "测试",
    edit: "编辑",
    delete: "删除",
    deleteTitle: "删除代理 IP？",
    deleteCopy: "“{name}”将从代理列表中移除，此操作无法撤销。",
    deleteConfirm: "删除",
    testSuccess: "连接正常 · 出口 {ip} · {region} · {latency} ms",
    testFailure: "连接失败 · {error}",
    nameRequired: "请输入名称。",
    nameInvalid: "名称包含不支持的字符。",
    nameTooLong: "名称过长。",
    typeInvalid: "请选择 HTTP、HTTPS 或 SOCKS5。",
    hostRequired: "请输入地址。",
    hostInvalid: "地址不能包含空格或控制字符。",
    hostTooLong: "地址过长。",
    portInvalid: "端口应在 1 到 65535 之间。",
    usernameInvalid: "用户名包含不支持的字符。",
    usernameTooLong: "用户名过长。",
    passwordInvalid: "密码包含不支持的字符。",
    passwordTooLong: "密码过长。",
    errorInvalidName: "请输入名称。",
    errorInvalidType: "请选择 HTTP、HTTPS 或 SOCKS5。",
    errorInvalidHost: "请输入有效的地址。",
    errorInvalidPort: "端口应在 1 到 65535 之间。",
    errorInvalidUsername: "用户名无效。",
    errorInvalidPassword: "密码无效。",
    errorNotFound: "这个代理已不存在。",
    errorInvalidJson: "请求不是有效的 JSON。",
    errorTooLarge: "请求内容过大。",
    errorUnauthorized: "本地服务令牌已失效，请重新加载页面。",
    errorForbidden: "本地服务拒绝了请求。",
    errorInternal: "本地服务无法完成这个请求。",
    errorAccountNotFound: "这个身份已不存在。",
    errorAccountSignedIn: "该账号仍处于登录状态，请先在 magpie 中登出。",
    errorAccountAuthUnreadable: "无法读取已登录的账号，因此没有做任何更改。",
    errorAccountInvalid: "身份引用无效。",
    errorAccountRetiredMissing: "该供应商下已没有这个身份。",
    errorAccountMismatch: "登录返回的账号与所选身份不一致，因此没有写入任何凭据。",
    errorNetwork: "无法连接本地服务。",
    errorGeneric: "请求失败。",
    testTimeout: "连接超时。",
    testRefused: "代理拒绝了连接。",
    testDns: "无法解析代理地址。",
    testReset: "代理关闭了连接。",
    testProxyAuth: "代理认证失败。",
    testTunnel: "代理拒绝了隧道连接。",
    testEndpointHttp: "检测地址返回了 HTTP 错误。",
    testEndpointJson: "检测地址没有返回可用的 JSON。",
    testTls: "无法与检测地址建立安全连接。",
    testSocksAuth: "SOCKS5 认证失败。",
    testSocksRefused: "SOCKS5 代理拒绝了连接。",
    testSocksHost: "SOCKS5 代理无法访问检测地址。",
    testSocksGeneral: "SOCKS5 代理无法连接。",
    testUnknown: "无法通过这个代理访问检测地址。",
    accounts: "账号",
    accountsTitle: "账号",
    accountsCopy: "通过msg登录过的每个账号、它锁定的浏览器指纹，以及 who.1ms.dog 对这个身份的判定。",
    accountsRefresh: "刷新",
    accountsRefreshing: "刷新中…",
    accountsRefreshed: "已读取 {count} 个账号。",
    accountSearchLabel: "搜索账号",
    accountSearchPlaceholder: "搜索账号",
    accountSortLabel: "排序",
    accountSortLastLogin: "最近登录",
    accountSortName: "账号名",
    accountSortProvider: "供应商",
    accountSortGrade: "检测评级",
    accountFilterLabel: "状态",
    accountFilterAll: "全部",
    accountFilterSignedIn: "已登录",
    accountFilterSignedOut: "已登出",
    accountFilterCount: "显示 {shown} / 共 {total}",
    accountEmpty: "还没有账号",
    accountEmptyCopy: "通过msg登录之后，账号会显示在这里。",
    accountNoMatch: "没有符合筛选条件的账号。",
    accountColName: "账号",
    accountColFingerprint: "指纹",
    accountColLastLogin: "上次登录",
    accountColCheck: "身份检测",
    accountColStatus: "状态",
    accountColActions: "操作",
    accountUnverified: "未验证流程",
    accountUnverifiedTitle: "这个账号来自一条还没有在msg中验证过的登录流程。",
    accountSignedIn: "已登录",
    accountSignedOut: "已登出 · 保留身份",
    accountCheckNone: "未检测",
    accountChecking: "检测中…",
    accountFingerprintPinned: "固定于 {time}",
    accountFingerprintNone: "没有固定指纹",
    accountExitDirect: "直连",
    accountLastLoginAt: "{time} · {exit}",
    accountCheckExposure: "{count} 处可能暴露你",
    accountRelogin: "重新登录",
    accountReloginTitle: "沿用这个账号保留的指纹重新登录，不会生成新的身份。",
    accountCheck: "检测",
    accountDetail: "详情",
    accountClear: "清除身份",
    accountCheckBusy: "已有检测在进行。",
    gradeLegendLabel: "判定",
    gradeA: "干净 · 可以用",
    gradeB: "可用 · 有痕迹",
    gradeC: "建议换出口",
    gradeD: "不要用这个出口",
    gradeDisclaimer: "这是第三方站点 who.1ms.dog 的判定，不等于供应商风控结论，也不是我们自建的指纹评分。",
    gradeMeaningA: "干净：出口和身份对得上，可以拿去用。",
    gradeMeaningB: "可用：站点看得出你走了一条代理，但没有自相矛盾。",
    gradeMeaningC: "建议换出口：身份和出口对不上，换一个出口再测。",
    gradeMeaningD: "不要用这个出口：多处矛盾，先换成别的出口。",
    accountDetailTitle: "账号",
    accountDetailProvider: "供应商",
    accountDetailKey: "账号键",
    accountDetailFingerprint: "指纹 id",
    accountDetailPinnedAt: "固定时间",
    accountDetailLastLoginExit: "上次登录出口",
    accountDetailStatus: "状态",
    accountDetailNote: "备注",
    accountDetailNoteSave: "保存备注",
    accountDetailNoteSaving: "保存中…",
    accountDetailNoteHint: "备注只保存在这个账号上，最多 200 个字符。",
    accountDetailNoteEmpty: "还没有备注。",
    accountDetailSaved: "备注已保存。",
    accountDetailNoteTooLong: "备注过长。",
    accountDetailSigninHint: "该账号仍在登录状态。先在 magpie 中登出，这里才能清除它的身份。",
    accountDetailRetiredHint: "指纹与该账号的配置目录同生共死：只要不「清除身份」，再次登录会重用同一个指纹。",
    accountDetailHistoryTitle: "检测历史",
    accountDetailHistoryEmpty: "还没有检测过。检测会用这个身份打开 who.1ms.dog。",
    accountDetailHistoryLine: "{grade} · {time} · {exit} · {exposure} 处暴露",
    accountDetailDismiss: "关闭",
    accountCheckFailedExit: "出口：{exit}",
    accountCheckTitle: "身份检测",
    accountCheckCopy: "会用这个账号自己的浏览器指纹打开 who.1ms.dog，并读回站点的判定。",
    accountCheckProxyLabel: "代理 IP",
    accountCheckProxyDirect: "不使用代理（直连）",
    accountCheckProxyHint: "登录时用的出口不会被记录；这次检测看的是你在这里选的出口。",
    accountCheckTargetLabel: "目标站点",
    accountCheckEtaLabel: "预计用时",
    accountCheckEtaValue: "以站点实际返回为准",
    accountCheckExitLabel: "出口",
    accountCheckTimeLabel: "时间",
    accountCheckGradeLabel: "评级",
    accountCheckIdentityLabel: "使用身份",
    accountCheckNote: "该站点不允许被其他页面嵌入。msg会打开一个隔离窗口，读完判定就关掉。",
    accountCheckStart: "开始检测",
    accountCheckRunningOpening: "正在打开隔离浏览器…",
    accountCheckRunningReading: "正在读取站点的判定…",
    accountCheckElapsed: "{seconds} 秒",
    accountCheckCancel: "取消检测",
    accountCheckCancelled: "检测已取消，本次没有产生判定。",
    accountCheckSummary: "who.1ms.dog 判定 · 出口 {exit} · {time}",
    accountCheckNoExposure: "站点没有标出任何矛盾",
    accountCheckResultNote: "判定只记在这个账号上，不会上报到别处。",
    accountCheckAgain: "重新检测",
    accountCheckReexit: "换出口重测",
    accountCheckDetails: "详情",
    accountCheckFailedTitle: "这次检测没有完成",
    accountCheckFailedDetail: "{reason}（出口：{exit}）",
    accountCheckFailedNoVerdict: "这次检测没有完成，所以没有产生新判定。",
    accountCheckFailedKeepPrevious: "上一次的判定仍然是 {grade} · {time}（{exit}），没有变化。",
    accountCheckFailedNoPrevious: "这个账号还没有任何判定记录。",
    accountCheckRetry: "重试",
    accountCheckChangeExit: "换个出口",
    accountCheckDismiss: "关闭",
    checkErrorBrowserMissing: "隔离浏览器未安装，请先准备登录浏览器。",
    checkErrorExecutableMissing: "浏览器可执行文件缺失，请重新准备登录浏览器。",
    checkErrorIdentityMissing: "这个账号还没有固定指纹，检测无法开始。",
    checkErrorLaunchFailed: "隔离浏览器没起来，通常是安装目录被占用或文件缺失。",
    checkErrorLaunchTimeout: "隔离浏览器启动超时。",
    checkErrorPageTimeout: "who.1ms.dog 没有在限定时间内给出判定。可能是站点慢，也可能是出口把请求吞了。",
    checkErrorVerdictMissing: "who.1ms.dog 这次没有给出判定。",
    checkErrorCancelled: "检测已取消，因此没有产生判定。",
    checkErrorProxyNotFound: "所选代理已不存在，请换一个出口。",
    checkErrorAccountNotFound: "这个账号已不存在，请刷新列表。",
    checkErrorCheckBusy: "已有检测在进行，请等它结束。",
    checkErrorInternal: "本地服务无法完成这次检测。",
    checkErrorUnknown: "检测在产生判定之前中止了。",
    errorInvalidNote: "备注无效。",
    toastNoteSaved: "备注已保存。",
    toastCheckDone: "检测完成 · 评级 {grade}。",
    toastCheckCancelled: "检测已取消。",
    toastRefreshed: "账号列表已刷新。",
  },
  "zh-Hant": {
    title: "msg",
    subtitle: "代理出口、隔離登入與帳號帳本，一處管好。",
    providers: "供應商",
    proxies: "代理 IP",
    providersTitle: "供應商",
    providersCopy: "支援的供應商及其目前的登入就緒狀態。",
    providersEmptyTitle: "還沒有供應商",
    providersEmptyCopy: "本機服務就緒後，支援的供應商會顯示在這裡。",
    providersMoreTitle: "其他訂閱類供應商",
    providersMoreHint: "其餘訂閱類供應商都在這裡：magpie 內建的，以及為 magpie 撰寫、對照過內建登入的外掛。",
    providerPending: "等待驗證",
    providerReady: "就緒",
    providerBlocked: "已封鎖",
    providersSourceMagpie: "名單來自 magpie",
    providersSourceLocal: "未取得 magpie 名單 · 使用本機名單",
    providersDiff: "兩邊都有 {both} · 僅本機 {localOnly} · 僅 magpie {magpieOnly}",
    providersDiffNone: "本機名單與 magpie 一致。",
    providersDiffUnavailable: "無法讀取 magpie 的供應商名單，因此無法顯示差異。",
    providerMethodsHeading: "已安裝外掛中找到的登入方式",
    providerMethodBrowserTag: "瀏覽器",
    providerMethodDeviceTag: "設備碼",
    providerMethodFormTag: "需要填表",
    providerMethodLocalTag: "本機登入狀態",
    providerMethodKeyTag: "金鑰",
    providerMethodSecretTag: "貼上密鑰",
    providerMethodPendingTag: "方式待確認",
    providerMethodUnknownTag: "方式待確認",
    providerMethodNote: "登入方式在開始登入時才會確認，以實際開啟的頁面為準。",
    providerSourceLineHeading: "名單來源",
    providerSourceLocal: "本機登錄檔",
    providerSourceMagpie: "magpie 名單",
    providerSourcePlugins: "已安裝外掛",
    providerPluginsFound: "已安裝供應商項目 {count} 個 · {browser} 個需要瀏覽器",
    providerPluginsScanning: "正在掃描已安裝外掛…",
    providerPluginsUnavailable: "無法掃描已安裝外掛",
    providerPluginsFailed: "已安裝外掛掃描失敗：{error}",
    providerPluginsScanTimedOut: "已安裝外掛掃描仍在進行。重新整理頁面以查看結果。",
    addAccount: "新增帳號",
    reportIssue: "回報問題",
    reportTitle: "回報問題",
    reportCopy: "正文已經幫你寫好了。點一下就會用系統預設瀏覽器開啟 GitHub 的新建 issue 頁面，標題和正文都填好，你只要再點 Create 就送出去了。",
    reportNoteLabel: "補充說明（選填）",
    reportNoteHint: "寫下你看到的現象、點過的按鈕、實際結果。留空也能直接送。",
    reportDraftLabel: "將要提交的內容",
    reportDraftHint: "內容不含帳號、cookie、權杖或代理憑證。",
    reportOpen: "在瀏覽器中開啟",
    reportCopyBody: "複製正文",
    reportCancel: "取消",
    reportPreparing: "正在準備正文…",
    reportOpened: "已在瀏覽器中開啟，標題和正文都填好了，點一下 Create 就送出去了。",
    reportCopied: "正文已複製。",
    reportCopyFailed: "複製被攔住了，請手動選取上面的正文再複製。",
    reportBuildFailed: "沒能產生回報正文。",
    signInTitle: "新增帳號",
    signInCopy: "這會開啟一個隔離瀏覽器視窗。請在視窗裡完成登入，msg會把產生的憑證寫入 magpie。",
    signInUnverified: "此流程尚未在msg中驗證過。你可以直接嘗試，失敗會如實回報，也歡迎回報問題。",
    signInProxyLabel: "代理 IP",
    signInProxyDirect: "不使用代理（直連）",
    signInMethodLabel: "登入方式",
    signInMethodHint: "該供應商提供了多個登入方式，請選擇你要用的那一個；選錯會登入到錯誤的站點。",
    signInStart: "開始登入",
    signInStarting: "正在開始…",
    signInOpened: "已在隔離瀏覽器視窗開啟登入頁，請在那個視窗裡完成登入。",
    signInNavigationWarning: "瀏覽器已開啟，但頁面未在限定時間內載入完成。你仍可在已開啟的視窗裡手動完成登入。",
    signInCancel: "取消登入",
    signInClose: "關閉",
    signInStateAuthorizing: "正在取得登入網址…",
    signInStateWaiting: "等待你在瀏覽器視窗中完成登入…",
    signInStateFinishing: "正在把憑證寫入 magpie…",
    signInStateDone: "已完成",
    signInStateError: "失敗",
    signInStateCancelled: "已取消",
    signInAccountKey: "帳號金鑰",
    signInAccountLabel: "沿用現有身分繼續登入",
    signInAccountHint: "這個身分保留自己的瀏覽器指紋。沿用時會重用該指紋，而不是重新產生。",
    signInAccountNew: "新帳號（新的指紋）",
    signInDone: "登入完成，憑證已寫入 magpie。",
    signInCancelled: "登入已取消。",
    signInBusy: "已有登入正在進行。",
    identitiesTitle: "帳號身分",
    identitiesCopy: "每個帳號都有自己的瀏覽器指紋。已登出的身分會被保留，因此再次登入時會重用同一個指紋，而不是重新產生。",
    identitiesEmpty: "目前沒有已登出的身分。",
    identitiesLastSignedIn: "上次登入於 {time}",
    identitiesClear: "清除身分",
    identitiesClearing: "清除中…",
    identitiesCleared: "身分已清除。",
    identitiesClearTitle: "清除這個身分？",
    identitiesClearCopy: "「{name}」保留的瀏覽器指紋與設定檔會被刪除。該帳號下次登入時會產生新的指紋。",
    identitiesClearConfirm: "清除身分",
    identitiesError: "無法載入身分列表。",
    identitiesLoading: "正在讀取保留的身分…",
    identitiesRetry: "重試",
    environmentTitle: "登入瀏覽器設定",
    environmentCopy: "msg需要一次性準備一個隔離瀏覽器，登入頁面不會出現在日常瀏覽器中。只有點擊「準備」後才會開始下載。",
    environmentSizeLabel: "下載大小",
    environmentSizeValue: "下載 {size} · 磁碟佔用約 {extracted}",
    environmentDiskLabel: "可用磁碟空間",
    environmentDiskValue: "可用 {free} · 需要 {required}",
    environmentLocationLabel: "安裝位置",
    environmentNote: "瀏覽器檔案保存在本外掛自己的快取中，不會寫入你共用的 Camoufox 快取。",
    environmentChecksumVerified: "下載已按發佈的 sha256 校驗。",
    environmentChecksumUnverified: "已覆寫瀏覽器 URL 且未提供 sha256，因此下載未做校驗。",
    environmentBadgeMissing: "未安裝",
    environmentBadgeReady: "已就緒",
    environmentBadgePreparing: "正在準備…",
    environmentBadgeError: "設定失敗",
    environmentBadgeCancelled: "已取消",
    environmentProgress: "{percent}% · {received} / {total}",
    environmentPrepare: "準備瀏覽器",
    environmentCancel: "取消",
    environmentRetry: "重試",
    errorInsufficientDisk: "磁碟可用空間不足，無法安裝登入瀏覽器。",
    errorInstallerUnavailable: "此安裝中缺少瀏覽器執行環境。",
    errorDownloadFailed: "瀏覽器下載失敗。",
    errorRateLimited: "GitHub 對下載進行了限流。請設定 GITHUB_TOKEN 或瀏覽器 URL 覆寫後重試。",
    errorExtractFailed: "無法解壓縮瀏覽器壓縮檔。",
    errorEnvironmentUnknown: "瀏覽器設定失敗。",
    proxiesTitle: "代理 IP",
    proxiesCopy: "帳號透過你選擇的代理完成登入和後續請求。",
    proxiesEmptyTitle: "還沒有代理 IP",
    proxiesEmptyCopy: "新增代理，為供應商提供乾淨的出口。",
    addProxy: "新增代理",
    connecting: "正在連線…",
    ready: "本機服務已連線",
    failed: "本機服務無法使用",
    retry: "重試",
    name: "名稱",
    type: "類型",
    host: "位址",
    port: "連接埠",
    username: "使用者名稱",
    password: "密碼",
    optional: "（選填）",
    addProxyTitle: "新增代理 IP",
    editProxyTitle: "編輯代理 IP",
    proxyDialogCopy: "支援 HTTP、HTTPS 和 SOCKS5。密碼只保存在本機，之後不會再顯示。",
    namePlaceholder: "新加坡 · 01",
    hostPlaceholder: "127.0.0.1",
    portPlaceholder: "1080",
    passwordKeepHint: "已儲存密碼。留空表示維持不變。",
    testConnection: "測試連線",
    testing: "正在測試…",
    save: "儲存",
    saving: "正在儲存…",
    cancel: "取消",
    close: "關閉",
    statusUntested: "未檢測",
    statusTesting: "正在測試…",
    statusOk: "可用",
    statusError: "失敗",
    never: "從未",
    unknown: "未知",
    lastChecked: "上次檢測",
    exitIp: "出口 IP",
    colName: "名稱",
    colAddress: "位址",
    colRegion: "地區",
    colStatus: "狀態",
    colChecked: "上次檢測",
    colScore: "評分",
    scoreAction: "評分",
    scoring: "評分中…",
    scoreFailed: "評分失敗",
    scoreBusy: "已在評分中。",
    scoreStateLaunching: "正在開啟瀏覽器…",
    scoreStateMeasuring: "正在讀取 Trust Score…",
    scoreStateDone: "評分已儲存。",
    scoreStateError: "評分失敗",
    scoreNavigationFailed: "評分瀏覽器已開啟，但頁面未在限定時間內載入完成。可在已開啟的視窗中完成檢測，或稍後重試。",
    scoreStateCancelled: "評分已取消。",
    scoreCancel: "關閉視窗",
    filterRegionLabel: "地區",
    filterAllRegions: "全部",
    filterLatencyLabel: "延遲（毫秒）",
    filterLatencyMin: "最小",
    filterLatencyMax: "最大",
    filterReset: "重設",
    filterCount: "已篩選 {shown} / 共 {total}",
    filterNoMatch: "沒有符合篩選條件的代理。",
    regionUntested: "未檢測",
    test: "測試",
    edit: "編輯",
    delete: "刪除",
    deleteTitle: "刪除代理 IP？",
    deleteCopy: "「{name}」將從代理清單中移除，此操作無法復原。",
    deleteConfirm: "刪除",
    testSuccess: "連線正常 · 出口 {ip} · {region} · {latency} ms",
    testFailure: "連線失敗 · {error}",
    nameRequired: "請輸入名稱。",
    nameInvalid: "名稱包含不支援的字元。",
    nameTooLong: "名稱過長。",
    typeInvalid: "請選擇 HTTP、HTTPS 或 SOCKS5。",
    hostRequired: "請輸入位址。",
    hostInvalid: "位址不能包含空格或控制字元。",
    hostTooLong: "位址過長。",
    portInvalid: "連接埠應在 1 到 65535 之間。",
    usernameInvalid: "使用者名稱包含不支援的字元。",
    usernameTooLong: "使用者名稱過長。",
    passwordInvalid: "密碼包含不支援的字元。",
    passwordTooLong: "密碼過長。",
    errorInvalidName: "請輸入名稱。",
    errorInvalidType: "請選擇 HTTP、HTTPS 或 SOCKS5。",
    errorInvalidHost: "請輸入有效的位址。",
    errorInvalidPort: "連接埠應在 1 到 65535 之間。",
    errorInvalidUsername: "使用者名稱無效。",
    errorInvalidPassword: "密碼無效。",
    errorNotFound: "這個代理已不存在。",
    errorInvalidJson: "請求不是有效的 JSON。",
    errorTooLarge: "請求內容過大。",
    errorUnauthorized: "本機服務權杖已失效，請重新載入頁面。",
    errorForbidden: "本機服務拒絕了請求。",
    errorInternal: "本機服務無法完成這個請求。",
    errorAccountNotFound: "這個身分已不存在。",
    errorAccountSignedIn: "該帳號仍處於登入狀態，請先在 magpie 中登出。",
    errorAccountAuthUnreadable: "無法讀取已登入的帳號，因此沒有做任何變更。",
    errorAccountInvalid: "身分參照無效。",
    errorAccountRetiredMissing: "該供應商下已沒有這個身分。",
    errorAccountMismatch: "登入傳回的帳號與所選身分不一致，因此沒有寫入任何憑證。",
    errorNetwork: "無法連線本機服務。",
    errorGeneric: "請求失敗。",
    testTimeout: "連線逾時。",
    testRefused: "代理拒絕了連線。",
    testDns: "無法解析代理位址。",
    testReset: "代理關閉了連線。",
    testProxyAuth: "代理認證失敗。",
    testTunnel: "代理拒絕了通道連線。",
    testEndpointHttp: "檢測位址傳回了 HTTP 錯誤。",
    testEndpointJson: "檢測位址沒有傳回可用的 JSON。",
    testTls: "無法與檢測位址建立安全連線。",
    testSocksAuth: "SOCKS5 認證失敗。",
    testSocksRefused: "SOCKS5 代理拒絕了連線。",
    testSocksHost: "SOCKS5 代理無法存取檢測位址。",
    testSocksGeneral: "SOCKS5 代理無法連線。",
    testUnknown: "無法透過這個代理存取檢測位址。",
    accounts: "帳號",
    accountsTitle: "帳號",
    accountsCopy: "透過msg登入過的每個帳號、它鎖定的瀏覽器指紋，以及 who.1ms.dog 對這個身分的判定。",
    accountsRefresh: "重新整理",
    accountsRefreshing: "重新整理中…",
    accountsRefreshed: "已讀取 {count} 個帳號。",
    accountSearchLabel: "搜尋帳號",
    accountSearchPlaceholder: "搜尋帳號",
    accountSortLabel: "排序",
    accountSortLastLogin: "最近登入",
    accountSortName: "帳號名稱",
    accountSortProvider: "供應商",
    accountSortGrade: "檢測評級",
    accountFilterLabel: "狀態",
    accountFilterAll: "全部",
    accountFilterSignedIn: "已登入",
    accountFilterSignedOut: "已登出",
    accountFilterCount: "顯示 {shown} / 共 {total}",
    accountEmpty: "還沒有帳號",
    accountEmptyCopy: "透過msg登入之後，帳號會顯示在這裡。",
    accountNoMatch: "沒有符合篩選條件的帳號。",
    accountColName: "帳號",
    accountColFingerprint: "指紋",
    accountColLastLogin: "上次登入",
    accountColCheck: "身分檢測",
    accountColStatus: "狀態",
    accountColActions: "操作",
    accountUnverified: "未驗證流程",
    accountUnverifiedTitle: "這個帳號來自一條還沒有在msg中驗證過的登入流程。",
    accountSignedIn: "已登入",
    accountSignedOut: "已登出 · 保留身分",
    accountCheckNone: "未檢測",
    accountChecking: "檢測中…",
    accountFingerprintPinned: "固定於 {time}",
    accountFingerprintNone: "沒有固定指紋",
    accountExitDirect: "直連",
    accountLastLoginAt: "{time} · {exit}",
    accountCheckExposure: "{count} 處可能暴露你",
    accountRelogin: "重新登入",
    accountReloginTitle: "沿用這個帳號保留的指紋重新登入，不會產生新的身分。",
    accountCheck: "檢測",
    accountDetail: "詳情",
    accountClear: "清除身分",
    accountCheckBusy: "已有檢測在進行。",
    gradeLegendLabel: "判定",
    gradeA: "乾淨 · 可以用",
    gradeB: "可用 · 有痕跡",
    gradeC: "建議換出口",
    gradeD: "不要用這個出口",
    gradeDisclaimer: "這是第三方站點 who.1ms.dog 的判定，不等於供應商風控結論，也不是我們自建的指紋評分。",
    gradeMeaningA: "乾淨：出口和身分對得上，可以拿去用。",
    gradeMeaningB: "可用：站點看得出你走了一條代理，但沒有自相矛盾。",
    gradeMeaningC: "建議換出口：身分和出口對不上，換一個出口再測。",
    gradeMeaningD: "不要用這個出口：多處矛盾，先換成別的出口。",
    accountDetailTitle: "帳號",
    accountDetailProvider: "供應商",
    accountDetailKey: "帳號金鑰",
    accountDetailFingerprint: "指紋 id",
    accountDetailPinnedAt: "固定時間",
    accountDetailLastLoginExit: "上次登入出口",
    accountDetailStatus: "狀態",
    accountDetailNote: "備註",
    accountDetailNoteSave: "儲存備註",
    accountDetailNoteSaving: "儲存中…",
    accountDetailNoteHint: "備註只保存在這個帳號上，最多 200 個字元。",
    accountDetailNoteEmpty: "還沒有備註。",
    accountDetailSaved: "備註已儲存。",
    accountDetailNoteTooLong: "備註過長。",
    accountDetailSigninHint: "該帳號仍在登入狀態。先在 magpie 中登出，這裡才能清除它的身分。",
    accountDetailRetiredHint: "指紋與該帳號的設定檔同生共死：只要不「清除身分」，再次登入會重用同一個指紋。",
    accountDetailHistoryTitle: "檢測歷史",
    accountDetailHistoryEmpty: "還沒有檢測過。檢測會用這個身分打開 who.1ms.dog。",
    accountDetailHistoryLine: "{grade} · {time} · {exit} · {exposure} 處暴露",
    accountDetailDismiss: "關閉",
    accountCheckFailedExit: "出口：{exit}",
    accountCheckTitle: "身分檢測",
    accountCheckCopy: "會用這個帳號自己的瀏覽器指紋打開 who.1ms.dog，並讀回站點的判定。",
    accountCheckProxyLabel: "代理 IP",
    accountCheckProxyDirect: "不使用代理（直連）",
    accountCheckProxyHint: "登入時用的出口不會被記錄；這次檢測看的是你在這裡選的出口。",
    accountCheckTargetLabel: "目標站點",
    accountCheckEtaLabel: "預計用時",
    accountCheckEtaValue: "以站點實際回傳為準",
    accountCheckExitLabel: "出口",
    accountCheckTimeLabel: "時間",
    accountCheckGradeLabel: "評級",
    accountCheckIdentityLabel: "使用身分",
    accountCheckNote: "該站點不允許被其他頁面嵌入。msg會開啟一個隔離視窗，讀完判定就關掉。",
    accountCheckStart: "開始檢測",
    accountCheckRunningOpening: "正在開啟隔離瀏覽器…",
    accountCheckRunningReading: "正在讀取站點的判定…",
    accountCheckElapsed: "{seconds} 秒",
    accountCheckCancel: "取消檢測",
    accountCheckCancelled: "檢測已取消，本次沒有產生判定。",
    accountCheckSummary: "who.1ms.dog 判定 · 出口 {exit} · {time}",
    accountCheckNoExposure: "站點沒有標出任何矛盾",
    accountCheckResultNote: "判定只記在這個帳號上，不會上報到別處。",
    accountCheckAgain: "重新檢測",
    accountCheckReexit: "換出口重測",
    accountCheckDetails: "詳情",
    accountCheckFailedTitle: "這次檢測沒有完成",
    accountCheckFailedDetail: "{reason}（出口：{exit}）",
    accountCheckFailedNoVerdict: "這次檢測沒有完成，所以沒有產生新判定。",
    accountCheckFailedKeepPrevious: "上一次的判定仍然是 {grade} · {time}（{exit}），沒有變化。",
    accountCheckFailedNoPrevious: "這個帳號還沒有任何判定記錄。",
    accountCheckRetry: "重試",
    accountCheckChangeExit: "換個出口",
    accountCheckDismiss: "關閉",
    checkErrorBrowserMissing: "隔離瀏覽器未安裝，請先準備登入瀏覽器。",
    checkErrorExecutableMissing: "瀏覽器執行檔缺失，請重新準備登入瀏覽器。",
    checkErrorIdentityMissing: "這個帳號還沒有固定指紋，檢測無法開始。",
    checkErrorLaunchFailed: "隔離瀏覽器沒起來，通常是安裝目錄被佔用或檔案缺失。",
    checkErrorLaunchTimeout: "隔離瀏覽器啟動逾時。",
    checkErrorPageTimeout: "who.1ms.dog 沒有在限定時間內給出判定。可能是站點慢，也可能是出口把請求吞了。",
    checkErrorVerdictMissing: "who.1ms.dog 這次沒有給出判定。",
    checkErrorCancelled: "檢測已取消，因此沒有產生判定。",
    checkErrorProxyNotFound: "所選代理已不存在，請換一個出口。",
    checkErrorAccountNotFound: "這個帳號已不存在，請重新整理清單。",
    checkErrorCheckBusy: "已有檢測在進行，請等它結束。",
    checkErrorInternal: "本機服務無法完成這次檢測。",
    checkErrorUnknown: "檢測在產生判定之前中止了。",
    errorInvalidNote: "備註無效。",
    toastNoteSaved: "備註已儲存。",
    toastCheckDone: "檢測完成 · 評級 {grade}。",
    toastCheckCancelled: "檢測已取消。",
    toastRefreshed: "帳號清單已重新整理。",
  },
  ja: {
    title: "msg",
    subtitle: "プロキシ出口・分離ログイン・アカウント台帳を一か所で。",
    providers: "プロバイダー",
    proxies: "プロキシ IP",
    providersTitle: "プロバイダー",
    providersCopy: "対応プロバイダーと現在のログイン準備状況です。",
    providersEmptyTitle: "プロバイダーがありません",
    providersEmptyCopy: "ローカルサービスが準備できると、対応プロバイダーがここに表示されます。",
    providersMoreTitle: "その他のサブスクリプション",
    providersMoreHint: "残りのサブスクリプション提供元はここにすべて入ります。magpie 内蔵のものと、magpie 向けに作られ内蔵サインインと突き合わせ済みのプラグインです。",
    providerPending: "検証待ち",
    providerReady: "準備完了",
    providerBlocked: "ブロック中",
    providersSourceMagpie: "magpie から取得した一覧",
    providersSourceLocal: "magpie の一覧を取得できず · ローカル一覧を使用",
    providersDiff: "両方 {both} · ローカルのみ {localOnly} · magpie のみ {magpieOnly}",
    providersDiffNone: "ローカル一覧は magpie と一致しています。",
    providersDiffUnavailable: "magpie のプロバイダー一覧を読み取れなかったため、差分を表示できません。",
    providerMethodsHeading: "インストール済みプラグインで見つかったログイン方法",
    providerMethodBrowserTag: "ブラウザー",
    providerMethodDeviceTag: "デバイスコード",
    providerMethodFormTag: "入力が必要",
    providerMethodLocalTag: "ローカルセッション",
    providerMethodKeyTag: "キー",
    providerMethodSecretTag: "トークンを貼り付け",
    providerMethodPendingTag: "確認待ち",
    providerMethodUnknownTag: "確認待ち",
    providerMethodNote: "ログイン方法は実際に開始してから確定します。開いたページが正です。",
    providerSourceLineHeading: "一覧の出所",
    providerSourceLocal: "ローカル登録",
    providerSourceMagpie: "magpie の一覧",
    providerSourcePlugins: "インストール済みプラグイン",
    providerPluginsFound: "インストール済みプロバイダー {count} 件 · ブラウザーが必要 {browser} 件",
    providerPluginsScanning: "インストール済みプラグインをスキャン中…",
    providerPluginsUnavailable: "インストール済みプラグインをスキャンできません",
    providerPluginsFailed: "インストール済みプラグインのスキャンに失敗しました：{error}",
    providerPluginsScanTimedOut: "インストール済みプラグインのスキャンはまだ実行中です。ページを再読み込みすると結果が表示されます。",
    addAccount: "アカウントを追加",
    reportIssue: "問題を報告",
    reportTitle: "問題を報告",
    reportCopy: "本文はすでに用意されています。クリックすると既定のブラウザで GitHub の新しい issue が開き、タイトルと本文が入力済みです。Create を押すだけで投稿できます。",
    reportNoteLabel: "補足（任意）",
    reportNoteHint: "見たこと、押したボタン、実際の結果。空のままでも送れます。",
    reportDraftLabel: "送信される内容",
    reportDraftHint: "アカウント、cookie、トークン、プロキシの資格情報は含まれません。",
    reportOpen: "ブラウザで開く",
    reportCopyBody: "本文をコピー",
    reportCancel: "キャンセル",
    reportPreparing: "本文を準備しています…",
    reportOpened: "ブラウザで開きました。タイトルと本文は入力済みなので、Create を押すだけで投稿できます。",
    reportCopied: "本文をコピーしました。",
    reportCopyFailed: "コピーできませんでした。上の本文を選択して手動でコピーしてください。",
    reportBuildFailed: "報告本文を作成できませんでした。",
    signInTitle: "アカウントを追加",
    signInCopy: "隔離されたブラウザーウィンドウを開きます。そこでログインすると、msgが得られた認証情報を magpie に書き込みます。",
    signInUnverified: "このフローはmsgではまだ検証されていません。そのまま試せます。失敗はそのまま表示され、問題の報告も歓迎します。",
    signInProxyLabel: "プロキシ IP",
    signInProxyDirect: "プロキシを使用しない（直接接続）",
    signInMethodLabel: "ログイン方法",
    signInMethodHint: "このプロバイダーには複数のログイン方法があります。使うものを選んでください。選び違うと別のサイトへログインしてしまいます。",
    signInStart: "ログインを開始",
    signInStarting: "開始しています…",
    signInOpened: "隔離されたブラウザーウィンドウでログインページを開きました。そのウィンドウでログインを完了してください。",
    signInNavigationWarning: "ブラウザーは開いていますが、ページが制限時間内に読み込めませんでした。開いているウィンドウで手動でログインを完了できます。",
    signInCancel: "ログインをキャンセル",
    signInClose: "閉じる",
    signInStateAuthorizing: "認可を取得しています…",
    signInStateWaiting: "ブラウザーでのログイン完了を待っています…",
    signInStateFinishing: "認証情報を magpie に書き込んでいます…",
    signInStateDone: "完了",
    signInStateError: "失敗",
    signInStateCancelled: "キャンセル済み",
    signInAccountKey: "アカウントキー",
    signInAccountLabel: "既存のIDでログインを継続",
    signInAccountHint: "このIDは独自のブラウザ指紋を保持します。継続すると新しい指紋ではなく同じ指紋が使われます。",
    signInAccountNew: "新しいアカウント（新しい指紋）",
    signInDone: "ログインが完了し、認証情報を magpie に書き込みました。",
    signInCancelled: "ログインをキャンセルしました。",
    signInBusy: "すでにログインが進行中です。",
    identitiesTitle: "アカウントID",
    identitiesCopy: "各アカウントは独自のブラウザ指紋を持ちます。ログアウトしたIDは保持されるため、次にログインしても同じ指紋が使われ、新しい指紋が生成されることはありません。",
    identitiesEmpty: "ログアウトしたIDはまだありません。",
    identitiesLastSignedIn: "最終ログイン {time}",
    identitiesClear: "IDを消去",
    identitiesClearing: "消去中…",
    identitiesCleared: "IDを消去しました。",
    identitiesClearTitle: "このIDを消去しますか？",
    identitiesClearCopy: "「{name}」の保持されているブラウザ指紋とプロファイルを削除します。次回のログインでは新しい指紋が生成されます。",
    identitiesClearConfirm: "IDを消去",
    identitiesError: "ID一覧を読み込めませんでした。",
    identitiesLoading: "保持されているIDを読み込み中…",
    identitiesRetry: "再試行",
    environmentTitle: "ログイン用ブラウザーの準備",
    environmentCopy: "msgは、ログインページが普段のブラウザーに残らないよう、一度だけ隔離されたブラウザーを準備します。「準備」を選ぶまでダウンロードは始まりません。",
    environmentSizeLabel: "ダウンロード",
    environmentSizeValue: "ダウンロード {size} · ディスク約 {extracted}",
    environmentDiskLabel: "空きディスク容量",
    environmentDiskValue: "空き {free} · 必要 {required}",
    environmentLocationLabel: "インストール先",
    environmentNote: "ブラウザーのファイルはこのプラグイン専用のキャッシュに保存され、共有の Camoufox キャッシュには書き込みません。",
    environmentChecksumVerified: "ダウンロードは公開された sha256 で検証済みです。",
    environmentChecksumUnverified: "ブラウザー URL を上書きし sha256 を指定していないため、ダウンロードは検証されません。",
    environmentBadgeMissing: "未インストール",
    environmentBadgeReady: "準備完了",
    environmentBadgePreparing: "準備中…",
    environmentBadgeError: "セットアップ失敗",
    environmentBadgeCancelled: "キャンセル済み",
    environmentProgress: "{percent}% · {received} / {total}",
    environmentPrepare: "ブラウザーを準備",
    environmentCancel: "キャンセル",
    environmentRetry: "再試行",
    errorInsufficientDisk: "ログイン用ブラウザーをインストールする空きディスク容量が不足しています。",
    errorInstallerUnavailable: "このインストールにはブラウザーランタイムがありません。",
    errorDownloadFailed: "ブラウザーのダウンロードに失敗しました。",
    errorRateLimited: "GitHub がダウンロードをレート制限しました。GITHUB_TOKEN またはブラウザー URL の上書きを設定して再試行してください。",
    errorExtractFailed: "ブラウザーのアーカイブを展開できませんでした。",
    errorEnvironmentUnknown: "ブラウザーのセットアップに失敗しました。",
    proxiesTitle: "プロキシ IP",
    proxiesCopy: "アカウントは選択したプロキシ経由でログインし、リクエストを送ります。",
    proxiesEmptyTitle: "プロキシ IP がありません",
    proxiesEmptyCopy: "プロキシを追加して、プロバイダーにクリーンな出口を用意します。",
    addProxy: "プロキシを追加",
    connecting: "接続中…",
    ready: "ローカルサービスに接続しました",
    failed: "ローカルサービスを利用できません",
    retry: "再読み込み",
    name: "名前",
    type: "種類",
    host: "ホスト",
    port: "ポート",
    username: "ユーザー名",
    password: "パスワード",
    optional: "（任意）",
    addProxyTitle: "プロキシ IP を追加",
    editProxyTitle: "プロキシ IP を編集",
    proxyDialogCopy: "HTTP、HTTPS、SOCKS5 に対応しています。パスワードはローカルに保存され、再表示されません。",
    namePlaceholder: "シンガポール · 01",
    hostPlaceholder: "127.0.0.1",
    portPlaceholder: "1080",
    passwordKeepHint: "パスワードは保存済みです。空欄のままにすると変更しません。",
    testConnection: "接続テスト",
    testing: "テスト中…",
    save: "保存",
    saving: "保存中…",
    cancel: "キャンセル",
    close: "閉じる",
    statusUntested: "未テスト",
    statusTesting: "テスト中…",
    statusOk: "利用可能",
    statusError: "失敗",
    never: "なし",
    unknown: "不明",
    lastChecked: "最終テスト",
    exitIp: "出口 IP",
    colName: "名前",
    colAddress: "アドレス",
    colRegion: "地域",
    colStatus: "状態",
    colChecked: "最終テスト",
    colScore: "スコア",
    scoreAction: "スコア測定",
    scoring: "測定中…",
    scoreFailed: "スコア測定失敗",
    scoreBusy: "すでにスコア測定中です。",
    scoreStateLaunching: "ブラウザーを開いています…",
    scoreStateMeasuring: "Trust Score を読み取っています…",
    scoreStateDone: "スコアを保存しました。",
    scoreStateError: "スコア測定失敗",
    scoreNavigationFailed: "スコア測定用ブラウザーは開きましたが、ページが時間内に読み込まれませんでした。開いているウィンドウで続けるか、後でもう一度お試しください。",
    scoreStateCancelled: "スコア測定をキャンセルしました。",
    scoreCancel: "ウィンドウを閉じる",
    filterRegionLabel: "地域",
    filterAllRegions: "すべて",
    filterLatencyLabel: "レイテンシ（ミリ秒）",
    filterLatencyMin: "最小",
    filterLatencyMax: "最大",
    filterReset: "リセット",
    filterCount: "表示 {shown} / {total}",
    filterNoMatch: "条件に一致するプロキシがありません。",
    regionUntested: "未テスト",
    test: "テスト",
    edit: "編集",
    delete: "削除",
    deleteTitle: "プロキシ IP を削除しますか？",
    deleteCopy: "「{name}」をプロキシ一覧から削除します。元に戻せません。",
    deleteConfirm: "削除",
    testSuccess: "接続成功 · 出口 {ip} · {region} · {latency} ms",
    testFailure: "接続失敗 · {error}",
    nameRequired: "名前を入力してください。",
    nameInvalid: "名前に使用できない文字が含まれています。",
    nameTooLong: "名前が長すぎます。",
    typeInvalid: "HTTP、HTTPS、SOCKS5 のいずれかを選択してください。",
    hostRequired: "ホストを入力してください。",
    hostInvalid: "ホストに空白や制御文字は使用できません。",
    hostTooLong: "ホストが長すぎます。",
    portInvalid: "ポートは 1 から 65535 の範囲で入力してください。",
    usernameInvalid: "ユーザー名に使用できない文字が含まれています。",
    usernameTooLong: "ユーザー名が長すぎます。",
    passwordInvalid: "パスワードに使用できない文字が含まれています。",
    passwordTooLong: "パスワードが長すぎます。",
    errorInvalidName: "名前を入力してください。",
    errorInvalidType: "HTTP、HTTPS、SOCKS5 のいずれかを選択してください。",
    errorInvalidHost: "有効なホストを入力してください。",
    errorInvalidPort: "ポートは 1 から 65535 の範囲で入力してください。",
    errorInvalidUsername: "ユーザー名が無効です。",
    errorInvalidPassword: "パスワードが無効です。",
    errorNotFound: "このプロキシは存在しません。",
    errorInvalidJson: "リクエストが有効な JSON ではありません。",
    errorTooLarge: "リクエストが大きすぎます。",
    errorUnauthorized: "ローカルサービスのトークンが無効です。ページを再読み込みしてください。",
    errorForbidden: "ローカルサービスがリクエストを拒否しました。",
    errorInternal: "ローカルサービスがリクエストを完了できませんでした。",
    errorAccountNotFound: "このIDは存在しません。",
    errorAccountSignedIn: "このアカウントはまだサインイン中です。先に magpie でサインアウトしてください。",
    errorAccountAuthUnreadable: "サインイン中のアカウントを読み取れなかったため、何も変更しませんでした。",
    errorAccountInvalid: "このIDの指定が無効です。",
    errorAccountRetiredMissing: "このIDはこのプロバイダーに存在しません。",
    errorAccountMismatch: "サインインで返されたアカウントが選択したIDと異なるため、何も書き込みませんでした。",
    errorNetwork: "ローカルサービスに接続できません。",
    errorGeneric: "リクエストに失敗しました。",
    testTimeout: "接続がタイムアウトしました。",
    testRefused: "プロキシが接続を拒否しました。",
    testDns: "プロキシホストを解決できません。",
    testReset: "プロキシが接続を閉じました。",
    testProxyAuth: "プロキシ認証に失敗しました。",
    testTunnel: "プロキシがトンネルを拒否しました。",
    testEndpointHttp: "テスト先が HTTP エラーを返しました。",
    testEndpointJson: "テスト先が有効な JSON を返しませんでした。",
    testTls: "テスト先との安全な接続に失敗しました。",
    testSocksAuth: "SOCKS5 認証に失敗しました。",
    testSocksRefused: "SOCKS5 プロキシが接続を拒否しました。",
    testSocksHost: "SOCKS5 プロキシがテスト先に到達できません。",
    testSocksGeneral: "SOCKS5 プロキシが接続できません。",
    testUnknown: "このプロキシ経由でテスト先に到達できません。",
    accounts: "アカウント",
    accountsTitle: "アカウント",
    accountsCopy: "msgでログインした各アカウント、固定されたブラウザー指紋、who.1ms.dog による判定を表示します。",
    accountsRefresh: "再読み込み",
    accountsRefreshing: "再読み込み中…",
    accountsRefreshed: "{count} 件のアカウントを読み込みました。",
    accountSearchLabel: "アカウントを検索",
    accountSearchPlaceholder: "アカウントを検索",
    accountSortLabel: "並び替え",
    accountSortLastLogin: "最近のログイン",
    accountSortName: "アカウント名",
    accountSortProvider: "プロバイダー",
    accountSortGrade: "判定ランク",
    accountFilterLabel: "状態",
    accountFilterAll: "すべて",
    accountFilterSignedIn: "ログイン中",
    accountFilterSignedOut: "ログアウト済み",
    accountFilterCount: "{shown} / {total} 件を表示",
    accountEmpty: "アカウントがありません",
    accountEmptyCopy: "msgでログインすると、ここにアカウントが表示されます。",
    accountNoMatch: "条件に一致するアカウントがありません。",
    accountColName: "アカウント",
    accountColFingerprint: "指紋",
    accountColLastLogin: "最終ログイン",
    accountColCheck: "身元判定",
    accountColStatus: "状態",
    accountColActions: "操作",
    accountUnverified: "未検証のフロー",
    accountUnverifiedTitle: "このアカウントはmsgで未検証のログインフローから作成されました。",
    accountSignedIn: "ログイン中",
    accountSignedOut: "ログアウト済み · 身分を保持",
    accountCheckNone: "未判定",
    accountChecking: "判定中…",
    accountFingerprintPinned: "{time} に固定",
    accountFingerprintNone: "固定された指紋がありません",
    accountExitDirect: "直接接続",
    accountLastLoginAt: "{time} · {exit}",
    accountCheckExposure: "{count} 箇所で情報が漏れる可能性",
    accountRelogin: "再ログイン",
    accountReloginTitle: "このアカウントの保持された指紋を再利用し、新しい身分は生成しません。",
    accountCheck: "判定",
    accountDetail: "詳細",
    accountClear: "身分を消去",
    accountCheckBusy: "すでに判定が進行中です。",
    gradeLegendLabel: "判定",
    gradeA: "クリーン · 使用可",
    gradeB: "使用可 · 痕跡あり",
    gradeC: "出口の変更を推奨",
    gradeD: "この出口は使わないでください",
    gradeDisclaimer: "これはサードパーティサイト who.1ms.dog の判定であり、プロバイダーのリスク管理結論でも、独自の指紋スコアでもありません。",
    gradeMeaningA: "クリーン：出口と身分が一致しており、使用できます。",
    gradeMeaningB: "使用可：プロキシは見えていますが、矛盾はありません。",
    gradeMeaningC: "出口の変更を推奨：身分と出口が一致しません。別の出口で再判定してください。",
    gradeMeaningD: "この出口は使わないでください：複数の矛盾があります。まず出口を変更してください。",
    accountDetailTitle: "アカウント",
    accountDetailProvider: "プロバイダー",
    accountDetailKey: "アカウントキー",
    accountDetailFingerprint: "指紋 ID",
    accountDetailPinnedAt: "固定日時",
    accountDetailLastLoginExit: "最終ログインの出口",
    accountDetailStatus: "状態",
    accountDetailNote: "メモ",
    accountDetailNoteSave: "メモを保存",
    accountDetailNoteSaving: "保存中…",
    accountDetailNoteHint: "メモはこのアカウントにのみ保存されます（最大 200 文字）。",
    accountDetailNoteEmpty: "メモはまだありません。",
    accountDetailSaved: "メモを保存しました。",
    accountDetailNoteTooLong: "メモが長すぎます。",
    accountDetailSigninHint: "このアカウントはまだログイン中です。身分を消去する前に magpie でログアウトしてください。",
    accountDetailRetiredHint: "指紋とアカウントのプロファイルは一体です。身分を消去しない限り、再ログインでは同じ指紋が使われます。",
    accountDetailHistoryTitle: "判定履歴",
    accountDetailHistoryEmpty: "まだ判定していません。判定ではこの身分で who.1ms.dog を開きます。",
    accountDetailHistoryLine: "{grade} · {time} · {exit} · {exposure} 箇所の露出",
    accountDetailDismiss: "閉じる",
    accountCheckFailedExit: "出口：{exit}",
    accountCheckTitle: "身元判定",
    accountCheckCopy: "このアカウント固有のブラウザー指紋で who.1ms.dog を開き、サイトの判定を読み取ります。",
    accountCheckProxyLabel: "プロキシ IP",
    accountCheckProxyDirect: "プロキシを使用しない（直接接続）",
    accountCheckProxyHint: "ログイン時の出口は記録されません。この判定ではここで選んだ出口を使います。",
    accountCheckTargetLabel: "対象サイト",
    accountCheckEtaLabel: "所要時間の目安",
    accountCheckEtaValue: "サイトの実際の応答に準じます",
    accountCheckExitLabel: "出口",
    accountCheckTimeLabel: "時刻",
    accountCheckGradeLabel: "ランク",
    accountCheckIdentityLabel: "使用する身分",
    accountCheckNote: "このサイトは埋め込みできません。msgが隔離ウィンドウを開き、判定を読み取って閉じます。",
    accountCheckStart: "判定を開始",
    accountCheckRunningOpening: "隔離ブラウザーを開いています…",
    accountCheckRunningReading: "サイトの判定を読み取っています…",
    accountCheckElapsed: "{seconds} 秒",
    accountCheckCancel: "判定をキャンセル",
    accountCheckCancelled: "判定はキャンセルされました。判定結果はありません。",
    accountCheckSummary: "who.1ms.dog の判定 · 出口 {exit} · {time}",
    accountCheckNoExposure: "サイトは矛盾を検出しませんでした",
    accountCheckResultNote: "判定はこのアカウントにのみ保存され、他へ送信されません。",
    accountCheckAgain: "再判定",
    accountCheckReexit: "別の出口で再判定",
    accountCheckDetails: "詳細",
    accountCheckFailedTitle: "今回の判定は完了しませんでした",
    accountCheckFailedDetail: "{reason}（出口：{exit}）",
    accountCheckFailedNoVerdict: "今回の判定は完了しなかったため、新しい判定は生成されませんでした。",
    accountCheckFailedKeepPrevious: "前回の判定は {grade} · {time}（{exit}）のままです。変更はありません。",
    accountCheckFailedNoPrevious: "このアカウントには判定記録がまだありません。",
    accountCheckRetry: "再試行",
    accountCheckChangeExit: "別の出口を選ぶ",
    accountCheckDismiss: "閉じる",
    checkErrorBrowserMissing: "隔離ブラウザーがありません。先にログイン用ブラウザーを準備してください。",
    checkErrorExecutableMissing: "ブラウザーの実行ファイルがありません。ログイン用ブラウザーを再準備してください。",
    checkErrorIdentityMissing: "このアカウントには固定された指紋がないため、判定を開始できません。",
    checkErrorLaunchFailed: "隔離ブラウザーが起動しませんでした。インストール先が使用中かファイルが不足している可能性があります。",
    checkErrorLaunchTimeout: "隔離ブラウザーの起動がタイムアウトしました。",
    checkErrorPageTimeout: "who.1ms.dog が時間内に判定を返しませんでした。サイトが遅いか、出口がリクエストを失った可能性があります。",
    checkErrorVerdictMissing: "who.1ms.dog から今回は判定を取得できませんでした。",
    checkErrorCancelled: "判定はキャンセルされたため、判定結果はありません。",
    checkErrorProxyNotFound: "選択したプロキシは存在しません。別の出口を選んでください。",
    checkErrorAccountNotFound: "このアカウントは存在しません。一覧を再読み込みしてください。",
    checkErrorCheckBusy: "すでに判定が進行中です。完了までお待ちください。",
    checkErrorInternal: "ローカルサービスがこの判定を完了できませんでした。",
    checkErrorUnknown: "判定結果が出る前に処理が停止しました。",
    errorInvalidNote: "メモが無効です。",
    toastNoteSaved: "メモを保存しました。",
    toastCheckDone: "判定完了 · ランク {grade}。",
    toastCheckCancelled: "判定をキャンセルしました。",
    toastRefreshed: "アカウント一覧を更新しました。",
  },
};

function languageOf(lang) {
  const parts = String(lang || "en").toLowerCase().replaceAll("_", "-").split("-");
  if (parts[0] === "zh") {
    return parts.includes("hant") ||
      (!parts.includes("hans") && parts.some((part) => ["tw", "hk", "mo"].includes(part)))
      ? "zh-Hant"
      : "zh-Hans";
  }
  return parts[0];
}

const query = new URLSearchParams(location.search);
const langKey = languageOf(query.get("lang") || navigator.language);
const text = messages[langKey] || messages.en;
document.documentElement.lang = messages[langKey] ? langKey : "en";

// The launcher passes the window theme it read from magpie. Fall back to the
// OS preference when there is none, so a plain browser visit still looks right.
const theme = query.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.dataset.theme = theme;
} else {
  document.documentElement.dataset.theme =
    window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

const token = document.querySelector('meta[name="clean-login-token"]')?.content || "";
const byId = (id) => document.getElementById(id);

let proxies = [];
const rowTests = new Map();
// Filter state is per document and never persisted: magpie mounts the page in
// an opaque-origin sandbox frame where web storage is not available.
const proxyFilter = { regions: new Set(), minLatency: "", maxLatency: "" };
let scoreJob = null;
let scoreStarting = false;
let scoreStartingId = "";
let scoreCancelling = false;
let scoreBrowserOpen = false;
let scoreNotice = "";
let scoreNoticeKind = "";
let scoreTimer = null;
const confirmController = createConfirmController();
// What the confirm dialog is about to delete: a proxy row or an account
// identity. The dialog is shared, so the kind is remembered with the target.
let confirmKind = "proxy";
let pendingIdentity = null;
let dialogContext = null;
let deleting = false;
let environment = null;
let environmentJob = null;
let environmentRequestError = "";
let environmentBusy = false;
let environmentTimer = null;
// The account identities the service knows about (GET /api/accounts). An
// identity is one account directory with its pinned fingerprint; the list
// never carries a path or a credential.
let accountIdentities = [];
let accountIdentitiesError = "";
let accountIdentitiesNotice = "";
let accountIdentitiesLoading = false;
let clearingIdentityKey = "";
// The accounts table is the same unified GET /api/accounts list as the
// identities card; it is never seeded with local rows. Its view state lives
// only in this document, like the proxy filters.
let providerCatalog = [];
let accountQuery = "";
let accountFilter = "all";
let accountSort = "lastLogin";
let accountsNotice = "";
let checkProxies = [];
let accountCheckContext = null;
let accountCheckTimer = null;
let accountCheckTicker = null;
let accountDetailContext = null;
let noteSaving = false;
const ACCOUNT_CHECK_POLL_MS = 800;
const ACCOUNT_CHECK_VISUAL_MS = 90_000;
const NOTE_MAX_LENGTH = 200;

const errorKeys = {
  signed_in: "errorAccountSignedIn",
  auth_unreadable: "errorAccountAuthUnreadable",
  retired_missing: "errorAccountRetiredMissing",
  identity_mismatch: "errorAccountMismatch",
  invalid_account: "errorAccountInvalid",
  invalid_name: "errorInvalidName",
  invalid_type: "errorInvalidType",
  invalid_host: "errorInvalidHost",
  invalid_port: "errorInvalidPort",
  invalid_username: "errorInvalidUsername",
  invalid_password: "errorInvalidPassword",
  not_found: "errorNotFound",
  invalid_json: "errorInvalidJson",
  payload_too_large: "errorTooLarge",
  unauthorized: "errorUnauthorized",
  forbidden: "errorForbidden",
  internal: "errorInternal",
  network: "errorNetwork",
};

const testErrorKeys = {
  timeout: "testTimeout",
  refused: "testRefused",
  dns: "testDns",
  reset: "testReset",
  proxy_auth: "testProxyAuth",
  proxy_tunnel: "testTunnel",
  endpoint_http: "testEndpointHttp",
  endpoint_json: "testEndpointJson",
  tls: "testTls",
  socks_auth: "testSocksAuth",
  socks_refused: "testSocksRefused",
  socks_host: "testSocksHost",
  socks_general: "testSocksGeneral",
  invalid_endpoint: "testEndpointJson",
  unknown: "testUnknown",
};

function apiErrorText(code) {
  return text[errorKeys[code]] || text.errorGeneric;
}

// The account routes reuse some codes (`not_found`) with an account-specific
// meaning, so they get their own map instead of the proxy wording.
const accountErrorKeys = {
  not_found: "errorAccountNotFound",
  signed_in: "errorAccountSignedIn",
  auth_unreadable: "errorAccountAuthUnreadable",
  invalid_account: "errorAccountInvalid",
  retired_missing: "errorAccountRetiredMissing",
  identity_mismatch: "errorAccountMismatch",
};

function accountErrorText(error) {
  return text[accountErrorKeys[error?.code]] || serverErrorText(error);
}

function testErrorText(result) {
  return text[testErrorKeys[result?.errorCode]] || result?.error || text.testUnknown;
}

// The score lifecycle has its own codes. `navigation_failed` needs a localised
// explanation; anything else keeps showing the raw host text.
const scoreErrorKeys = {
  navigation_failed: "scoreNavigationFailed",
};

function scoreReason(view) {
  const label = text[scoreErrorKeys[view?.errorCode]] || "";
  return [label, view?.error].filter(Boolean).join(" · ");
}

// A live warning is not an error: waiting-login and measuring stay active, and
// the user is told the open browser can still be used. Only the known code is
// localised; the raw host message is never shown here.
const NAVIGATION_WARNING_CODE = "navigation_failed";

function navigationWarningText(warning, key) {
  return warning?.code === NAVIGATION_WARNING_CODE ? text[key] : "";
}

const environmentErrorKeys = {
  insufficient_disk: "errorInsufficientDisk",
  installer_unavailable: "errorInstallerUnavailable",
  download_failed: "errorDownloadFailed",
  rate_limited: "errorRateLimited",
  extract_failed: "errorExtractFailed",
  checksum_mismatch: "errorDownloadFailed",
  install_failed: "errorDownloadFailed",
  unknown: "errorEnvironmentUnknown",
};

function environmentErrorText(code) {
  return text[environmentErrorKeys[code]] || text.errorEnvironmentUnknown;
}

function applyText() {
  document.title = text.title;
  byId("page-title").textContent = text.title;
  byId("page-subtitle").textContent = text.subtitle;
  byId("tab-providers-label").textContent = text.providers;
  byId("tab-proxies-label").textContent = text.proxies;
  byId("providers-title").textContent = text.providersTitle;
  byId("providers-copy").textContent = text.providersCopy;
  byId("providers-empty-title").textContent = text.providersEmptyTitle;
  byId("providers-empty-copy").textContent = text.providersEmptyCopy;
  byId("providers-more-title").textContent = text.providersMoreTitle;
  byId("providers-more-hint").textContent = text.providersMoreHint;
  byId("environment-title").textContent = text.environmentTitle;
  byId("environment-copy").textContent = text.environmentCopy;
  byId("environment-size-label").textContent = text.environmentSizeLabel;
  byId("environment-disk-label").textContent = text.environmentDiskLabel;
  byId("environment-location-label").textContent = text.environmentLocationLabel;
  byId("environment-badge").textContent = text.environmentBadgeMissing;
  byId("environment-prepare").textContent = text.environmentPrepare;
  byId("environment-cancel").textContent = text.environmentCancel;
  byId("environment-retry").textContent = text.environmentRetry;
  byId("proxies-title").textContent = text.proxiesTitle;
  byId("proxies-copy").textContent = text.proxiesCopy;
  byId("proxies-empty-title").textContent = text.proxiesEmptyTitle;
  byId("proxies-empty-copy").textContent = text.proxiesEmptyCopy;
  byId("add-proxy-label").textContent = text.addProxy;
  byId("add-proxy-empty").textContent = text.addProxy;
  byId("retry").textContent = text.retry;
  byId("col-name").textContent = text.colName;
  byId("col-address").textContent = text.colAddress;
  byId("col-region").textContent = text.colRegion;
  byId("col-status").textContent = text.colStatus;
  byId("col-checked").textContent = text.colChecked;
  byId("col-score").textContent = text.colScore;
  byId("filter-region-label").textContent = text.filterRegionLabel;
  byId("filter-latency-label").textContent = text.filterLatencyLabel;
  byId("filter-latency-min").placeholder = text.filterLatencyMin;
  byId("filter-latency-max").placeholder = text.filterLatencyMax;
  byId("filter-latency-min").setAttribute("aria-label", text.filterLatencyMin);
  byId("filter-latency-max").setAttribute("aria-label", text.filterLatencyMax);
  byId("filter-reset").textContent = text.filterReset;
  byId("score-cancel").textContent = text.scoreCancel;
  byId("label-name").textContent = text.name;
  byId("label-type").textContent = text.type;
  byId("label-port").textContent = text.port;
  byId("label-host").textContent = text.host;
  byId("username-label").textContent = text.username;
  byId("password-label").textContent = text.password;
  byId("username-optional").textContent = text.optional;
  byId("password-optional").textContent = text.optional;
  byId("proxy-name").placeholder = text.namePlaceholder;
  byId("proxy-host").placeholder = text.hostPlaceholder;
  byId("proxy-port").placeholder = text.portPlaceholder;
  byId("proxy-dialog-title").textContent = text.addProxyTitle;
  byId("proxy-dialog-copy").textContent = text.proxyDialogCopy;
  byId("test-proxy").textContent = text.testConnection;
  byId("proxy-cancel").textContent = text.cancel;
  byId("save-proxy").textContent = text.save;
  byId("proxy-close").setAttribute("aria-label", text.close);
  byId("confirm-title").textContent = text.deleteTitle;
  byId("confirm-copy").textContent = "";
  byId("confirm-cancel").textContent = text.cancel;
  byId("confirm-action").textContent = text.deleteConfirm;
  byId("confirm-close").setAttribute("aria-label", text.close);
  byId("signin-title").textContent = text.signInTitle;
  byId("signin-copy").textContent = text.signInCopy;
  byId("signin-unverified").textContent = text.signInUnverified;
  byId("signin-proxy-label").textContent = text.signInProxyLabel;
  byId("signin-method-label").textContent = text.signInMethodLabel;
  byId("signin-start").textContent = text.signInStart;
  byId("signin-cancel").textContent = text.signInCancel;
  byId("signin-close").setAttribute("aria-label", text.signInClose);
  byId("signin-close-footer").textContent = text.signInClose;
  byId("report-title").textContent = text.reportTitle;
  byId("report-copy").textContent = text.reportCopy;
  byId("report-note-label").textContent = text.reportNoteLabel;
  byId("report-note-hint").textContent = text.reportNoteHint;
  byId("report-draft-label").textContent = text.reportDraftLabel;
  byId("report-draft-hint").textContent = text.reportDraftHint;
  byId("report-open").textContent = text.reportOpen;
  byId("report-copy-body").textContent = text.reportCopyBody;
  byId("report-cancel").textContent = text.reportCancel;
  byId("report-close").setAttribute("aria-label", text.close);
  byId("signin-account-label").textContent = text.signInAccountLabel;
  byId("signin-account-hint").textContent = text.signInAccountHint;
  byId("identities-title").textContent = text.identitiesTitle;
  byId("identities-copy").textContent = text.identitiesCopy;
  byId("identities-retry").textContent = text.identitiesRetry;
  // --- accounts tab / panel ---
  byId("tab-accounts-label").textContent = text.accounts;
  byId("accounts-title").textContent = text.accountsTitle;
  byId("accounts-copy").textContent = text.accountsCopy;
  byId("accounts-refresh").textContent = text.accountsRefresh;
  byId("account-search-label").textContent = text.accountSearchLabel;
  byId("account-search").placeholder = text.accountSearchPlaceholder;
  byId("account-search").setAttribute("aria-label", text.accountSearchLabel);
  byId("account-sort-label").textContent = text.accountSortLabel;
  byId("account-sort-last-login").textContent = text.accountSortLastLogin;
  byId("account-sort-name").textContent = text.accountSortName;
  byId("account-sort-provider").textContent = text.accountSortProvider;
  byId("account-sort-grade").textContent = text.accountSortGrade;
  byId("account-filter-label").textContent = text.accountFilterLabel;
  byId("account-filter-all-label").textContent = text.accountFilterAll;
  byId("account-filter-signed-in-label").textContent = text.accountFilterSignedIn;
  byId("account-filter-signed-out-label").textContent = text.accountFilterSignedOut;
  byId("accounts-empty-title").textContent = text.accountEmpty;
  byId("accounts-empty-copy").textContent = text.accountEmptyCopy;
  for (const [id, label] of [
    ["account-col-name", text.accountColName],
    ["account-col-fingerprint", text.accountColFingerprint],
    ["account-col-last-login", text.accountColLastLogin],
    ["account-col-check", text.accountColCheck],
    ["account-col-status", text.accountColStatus],
    ["account-col-actions", text.accountColActions],
  ]) {
    byId(id).textContent = label;
    byId(id).setAttribute("data-label", label);
  }
  byId("grade-legend-label").textContent = text.gradeLegendLabel;
  byId("grade-a").textContent = text.gradeA;
  byId("grade-b").textContent = text.gradeB;
  byId("grade-c").textContent = text.gradeC;
  byId("grade-d").textContent = text.gradeD;
  byId("grade-disclaimer").textContent = text.gradeDisclaimer;
  // --- account detail dialog ---
  byId("account-detail-note-label").textContent = text.accountDetailNote;
  byId("account-detail-note-hint").textContent = text.accountDetailNoteHint;
  byId("account-detail-history-title").textContent = text.accountDetailHistoryTitle;
  byId("account-detail-dismiss").textContent = text.accountDetailDismiss;
  byId("account-detail-check").textContent = text.accountCheckStart;
  byId("account-detail-note-save").textContent = text.accountDetailNoteSave;
  byId("account-detail-close").setAttribute("aria-label", text.accountDetailDismiss);
  // --- account check dialog ---
  byId("account-check-title").textContent = text.accountCheckTitle;
  byId("account-check-close").setAttribute("aria-label", text.accountCheckDismiss);
  byId("account-check-proxy-label").textContent = text.accountCheckProxyLabel;
  byId("account-check-proxy-hint").textContent = text.accountCheckProxyHint;
  byId("account-check-target-label").textContent = text.accountCheckTargetLabel;
  byId("account-check-eta-label").textContent = text.accountCheckEtaLabel;
  byId("account-check-eta-value").textContent = text.accountCheckEtaValue;
  byId("account-check-identity-label").textContent = text.accountCheckIdentityLabel;
  byId("account-check-note").textContent = text.accountCheckNote;
  byId("account-check-grade-label").textContent = text.accountCheckGradeLabel;
  byId("account-check-exit-label").textContent = text.accountCheckExitLabel;
  byId("account-check-time-label").textContent = text.accountCheckTimeLabel;
  byId("account-check-result-note").textContent = text.accountCheckResultNote;
  byId("account-check-start").textContent = text.accountCheckStart;
  byId("account-check-again").textContent = text.accountCheckAgain;
  byId("account-check-reexit").textContent = text.accountCheckReexit;
  byId("account-check-details").textContent = text.accountCheckDetails;
  byId("account-check-retry").textContent = text.accountCheckRetry;
  byId("account-check-change-exit").textContent = text.accountCheckChangeExit;
  byId("account-check-cancel").textContent = text.accountCheckCancel;
  byId("account-check-dismiss").textContent = text.accountCheckDismiss;
}

function selectTab(name) {
  for (const [key, tabId, panelId] of [
    ["providers", "tab-providers", "panel-providers"],
    ["proxies", "tab-proxies", "panel-proxies"],
    ["accounts", "tab-accounts", "panel-accounts"],
  ]) {
    const active = key === name;
    byId(tabId).classList.toggle("is-active", active);
    byId(tabId).setAttribute("aria-selected", String(active));
    byId(panelId).hidden = !active;
  }
}

function setServiceState(state, label) {
  byId("service-state").dataset.state = state;
  byId("service-label").textContent = label;
}

function setFormError(message) {
  const node = byId("proxy-form-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setConfirmError(message) {
  const node = byId("confirm-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setTestResult(state, message) {
  const node = byId("proxy-test-result");
  node.className = `proxy-test-result${state ? ` ${state}` : ""}`;
  node.textContent = message;
  node.hidden = false;
}

function clearTestResult() {
  const node = byId("proxy-test-result");
  node.className = "proxy-test-result";
  node.textContent = "";
  node.hidden = true;
}

function formatTime(value) {
  if (!value) return text.never;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text.never;
  try {
    return new Intl.DateTimeFormat(langKey, { dateStyle: "medium", timeStyle: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

async function api(path, { method = "GET", body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        [TOKEN_HEADER]: token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    const wrapped = new Error("network");
    wrapped.code = "network";
    throw wrapped;
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A non-JSON error body is handled by the status check below.
  }
  if (!response.ok) {
    // A 403 token mismatch is expected when the service restarted while this
    // page stayed open. Reload once to pick up the new token; a second
    // mismatch (the reloaded document still carries the marker) falls through
    // to the normal error path instead of reloading again.
    if (data?.reload && reloadGuard.reloadOnce()) {
      return new Promise(() => {});
    }
    const error = new Error(data?.error || `http_${response.status}`);
    error.code = data?.error || `http_${response.status}`;
    // The server reports `{ error: code, message: humanText }`. Keep the two
    // apart so the sign-in dialog can show the exact code and message instead
    // of collapsing them into one string.
    error.serverMessage = typeof data?.message === "string" ? data.message : "";
    error.status = response.status;
    throw error;
  }
  return data;
}

function replaceProxy(proxy) {
  const index = proxies.findIndex((item) => item.id === proxy.id);
  if (index >= 0) proxies[index] = proxy;
  else proxies.push(proxy);
}

function miniButton(label, onClick, danger = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-button${danger ? " danger" : ""}`;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// True while this row's score is running locally. `scoreStartingId` covers the
// gap between the click and the POST response, when no job object exists yet.
function scoreActiveFor(proxyId) {
  if (scoreStarting && String(scoreStartingId) === String(proxyId)) return true;
  return isScoreActive(scoreJob?.state) && String(scoreJob?.proxyId || "") === String(proxyId);
}

// The Score cell. A running job wins over a stored value so the row shows
// progress; a failure shows the server's own reason instead of a stale score.
function proxyScoreCell(proxy) {
  const cell = document.createElement("div");
  cell.className = "proxy-score-cell";
  if (scoreActiveFor(proxy.id)) {
    const active = document.createElement("span");
    active.className = "proxy-score is-active";
    active.textContent = text.scoring;
    cell.append(active);
    return cell;
  }
  const view = scoreView(proxy);
  if (view.state === "failed") {
    const reason = scoreReason(view);
    const failed = document.createElement("span");
    failed.className = "proxy-score is-failed";
    failed.textContent = text.scoreFailed;
    cell.title = reason;
    cell.append(failed);
    if (reason) {
      const detail = document.createElement("small");
      detail.className = "proxy-score-error";
      detail.textContent = reason;
      cell.append(detail);
    }
    return cell;
  }
  if (view.state === "scored") {
    const value = document.createElement("span");
    value.className = `proxy-score ${view.tone}`;
    value.textContent = String(view.score);
    cell.append(value);
    if (view.label) {
      const label = document.createElement("small");
      label.className = "proxy-score-label";
      label.textContent = view.label;
      cell.append(label);
    }
    if (view.ip) {
      const ip = document.createElement("small");
      ip.className = "proxy-score-ip";
      ip.textContent = view.ip;
      cell.append(ip);
    }
    if (view.checkedAt) cell.title = formatTime(view.checkedAt);
    return cell;
  }
  const none = document.createElement("span");
  none.className = "proxy-score none";
  none.textContent = "—";
  cell.append(none);
  return cell;
}

function proxyRow(proxy) {
  const row = document.createElement("div");
  row.className = "proxy-row";
  row.dataset.proxyId = proxy.id;

  const name = document.createElement("div");
  name.className = "proxy-name";
  const title = document.createElement("strong");
  title.textContent = proxy.name || proxy.id;
  const type = document.createElement("small");
  type.textContent = String(proxy.type || "").toUpperCase();
  name.append(title, type);

  const address = document.createElement("div");
  address.className = "proxy-address";
  address.textContent = formatAddress(proxy);

  const region = document.createElement("div");
  region.className = "proxy-region";
  region.textContent = proxy.region || text.unknown;
  if (proxy.exitIp) {
    // The exit IP must stay readable: an ellipsized `111.24…` is useless for
    // telling exits apart. The label and the IP are separate spans so a narrow
    // column wraps between them instead of clipping the address, and the full
    // value is also on the tooltip.
    const exit = document.createElement("small");
    exit.className = "proxy-region-exit";
    exit.title = `${text.exitIp} ${proxy.exitIp}`;
    const label = document.createElement("span");
    label.className = "proxy-region-exit-label";
    label.textContent = text.exitIp;
    const ip = document.createElement("span");
    ip.className = "proxy-region-exit-ip";
    ip.textContent = proxy.exitIp;
    exit.append(label, document.createTextNode(" "), ip);
    region.append(exit);
  }

  const statusCell = document.createElement("div");
  statusCell.className = "proxy-status-cell";
  const view = statusView(proxy, text, rowTests.has(proxy.id));
  const status = document.createElement("span");
  status.className = `proxy-status ${view.state}`;
  status.textContent = view.state === "ok" && view.detail
    ? `${view.label} · ${view.detail}`
    : view.label;
  statusCell.append(status);
  if (view.state === "error") {
    const reason = document.createElement("small");
    reason.className = "proxy-error";
    reason.textContent = testErrorText(proxy);
    statusCell.append(reason);
  }

  const checked = document.createElement("div");
  checked.className = "proxy-checked";
  checked.textContent = formatTime(proxy.lastCheckedAt);

  const scoreCell = proxyScoreCell(proxy);

  const actions = document.createElement("div");
  actions.className = "proxy-actions";
  const testing = rowTests.has(proxy.id);
  const test = miniButton(testing ? text.testing : text.test, () => testRowProxy(proxy.id));
  test.disabled = testing;
  const running = scoreActiveFor(proxy.id);
  const score = miniButton(running ? text.scoring : text.scoreAction, () => scoreProxy(proxy.id));
  // No concurrency: while any score is running, every score button is disabled
  // (the server would answer 409). A local 409 still surfaces the busy message.
  score.disabled = running || scoreStarting || isScoreActive(scoreJob?.state);
  if (!running && score.disabled) score.title = text.scoreBusy;
  const edit = miniButton(text.edit, () => openProxyDialog(proxy));
  const remove = miniButton(text.delete, () => askDelete(proxy), true);
  actions.append(score, test, edit, remove);

  row.append(name, address, region, scoreCell, statusCell, checked, actions);
  return row;
}

function renderProxies() {
  const list = byId("proxies-list");
  const empty = byId("proxies-empty");
  const table = byId("proxy-table");
  const filters = byId("proxy-filters");
  byId("proxy-count").textContent = String(proxies.length);
  const hasProxies = proxies.length > 0;
  empty.hidden = hasProxies;
  table.hidden = !hasProxies;
  filters.hidden = !hasProxies;
  list.textContent = "";
  if (!hasProxies) {
    renderScoreBar();
    return;
  }
  renderFilterChips();
  const visible = filterProxies(proxies, proxyFilter);
  byId("filter-count").textContent = text.filterCount
    .replace("{shown}", String(visible.length))
    .replace("{total}", String(proxies.length));
  if (visible.length === 0) {
    const note = document.createElement("p");
    note.className = "proxy-filter-empty";
    note.textContent = text.filterNoMatch;
    list.append(note);
  } else {
    for (const proxy of visible) list.append(proxyRow(proxy));
  }
  renderScoreBar();
}

// Region chips rebuilt from the current data: one toggle per distinct region
// with its count, plus an "All" chip that clears the region selection. The
// untested/empty region is its own chip. Every control is type="button".
function renderFilterChips() {
  const wrap = byId("filter-regions");
  wrap.textContent = "";
  const regions = distinctRegions(proxies);
  const available = new Set(regions.map((item) => item.region));
  for (const region of [...proxyFilter.regions]) {
    if (!available.has(region)) proxyFilter.regions.delete(region);
  }
  const all = document.createElement("button");
  all.type = "button";
  all.className = `filter-chip filter-chip-all${proxyFilter.regions.size === 0 ? " is-active" : ""}`;
  all.setAttribute("aria-pressed", String(proxyFilter.regions.size === 0));
  all.textContent = text.filterAllRegions;
  all.addEventListener("click", () => {
    proxyFilter.regions.clear();
    renderProxies();
  });
  wrap.append(all);
  for (const { region, count } of regions) {
    const chip = document.createElement("button");
    chip.type = "button";
    const selected = proxyFilter.regions.has(region);
    chip.className = `filter-chip${selected ? " is-active" : ""}`;
    chip.dataset.region = region;
    chip.setAttribute("aria-pressed", String(selected));
    const label = document.createElement("span");
    label.textContent = region || text.regionUntested;
    const badge = document.createElement("span");
    badge.className = "filter-chip-count";
    badge.textContent = String(count);
    chip.append(label, badge);
    chip.addEventListener("click", () => {
      if (proxyFilter.regions.has(region)) proxyFilter.regions.delete(region);
      else proxyFilter.regions.add(region);
      renderProxies();
    });
    wrap.append(chip);
  }
}

function resetProxyFilters() {
  proxyFilter.regions.clear();
  proxyFilter.minLatency = "";
  proxyFilter.maxLatency = "";
  byId("filter-latency-min").value = "";
  byId("filter-latency-max").value = "";
  renderProxies();
}

// --- Trust Score -----------------------------------------------------------
//
// Clicking a row's Score button starts POST /api/proxies/<id>/score and then
// polls GET /api/proxy-score until the job settles; the list is re-read once it
// does. The job is singular, so the page refuses a second run locally and, if
// the server still answers 409 score_busy, adopts the running job and says so
// instead of failing silently.

function renderScoreBar() {
  const bar = byId("proxy-score-bar");
  const state = scoreJob?.state;
  const active = scoreStarting || isScoreActive(state);
  let message = "";
  let kind = "";
  if (scoreStarting) {
    message = text.scoreStateLaunching;
    kind = "active";
  } else if (isScoreActive(state)) {
    message = state === "measuring" ? text.scoreStateMeasuring : text.scoreStateLaunching;
    if (scoreJob?.proxyName) message = `${message} ${scoreJob.proxyName}`;
    const warning = state === "measuring" ? navigationWarningText(scoreJob?.warning, "scoreNavigationFailed") : "";
    if (warning) message = `${message} · ${warning}`;
    kind = "active";
  } else if (scoreNotice) {
    message = scoreNotice;
    kind = scoreNoticeKind;
  }
  bar.hidden = !message && !scoreBrowserOpen;
  bar.dataset.kind = kind;
  byId("proxy-score-state").textContent = message;
  const cancel = byId("score-cancel");
  cancel.hidden = !(active || scoreBrowserOpen);
  cancel.disabled = scoreCancelling;
}

function setScoreNotice(message, kind = "") {
  scoreNotice = message || "";
  scoreNoticeKind = kind;
}

function stopScorePolling() {
  if (scoreTimer) {
    clearTimeout(scoreTimer);
    scoreTimer = null;
  }
}

function startScorePolling() {
  stopScorePolling();
  scoreTimer = setTimeout(pollScore, 900);
}

async function reloadProxies() {
  try {
    const data = await api("api/proxies");
    if (Array.isArray(data?.proxies)) {
      proxies = data.proxies;
      renderProxies();
    }
  } catch (error) {
    setScoreNotice(serverErrorText(error), "error");
  }
}

async function pollScore() {
  scoreTimer = null;
  try {
    const data = await api("api/proxy-score");
    if (data && "job" in data) scoreJob = data.job;
    if (data && "browserOpen" in data) scoreBrowserOpen = Boolean(data.browserOpen);
  } catch (error) {
    // One dropped poll must not stop the loop; the next tick retries.
    setScoreNotice(serverErrorText(error), "error");
    if (scoreStarting || isScoreActive(scoreJob?.state)) startScorePolling();
    renderProxies();
    return;
  }
  const state = scoreJob?.state;
  if (scoreStarting || isScoreActive(state)) {
    renderProxies();
    startScorePolling();
    return;
  }
  scoreStarting = false;
  scoreStartingId = "";
  if (isScoreSettled(state)) {
    if (state === "error") {
      const detail = scoreReason({ errorCode: scoreJob?.errorCode, error: scoreJob?.error });
      setScoreNotice([text.scoreStateError, detail].filter(Boolean).join(" · "), "error");
    } else if (state === "cancelled") {
      setScoreNotice(text.scoreStateCancelled);
    } else {
      setScoreNotice(text.scoreStateDone);
    }
    await reloadProxies();
  }
  renderProxies();
}

async function adoptScoreJob() {
  try {
    const data = await api("api/proxy-score");
    if (data && "job" in data) scoreJob = data.job;
    if (data && "browserOpen" in data) scoreBrowserOpen = Boolean(data.browserOpen);
    renderProxies();
    if (isScoreActive(scoreJob?.state)) startScorePolling();
  } catch (error) {
    setScoreNotice(serverErrorText(error), "error");
    renderProxies();
  }
}

async function scoreProxy(id) {
  if (scoreStarting || isScoreActive(scoreJob?.state)) {
    setScoreNotice(text.scoreBusy, "warn");
    renderProxies();
    return;
  }
  const proxy = proxies.find((item) => item.id === id);
  if (!proxy) return;
  scoreStarting = true;
  scoreStartingId = id;
  setScoreNotice("");
  scoreBrowserOpen = true;
  renderProxies();
  try {
    const data = await api(`api/proxies/${encodeURIComponent(id)}/score`, { method: "POST" });
    scoreStarting = false;
    scoreStartingId = "";
    scoreJob = data?.job ?? { state: "launching", proxyId: id, proxyName: proxy.name };
    if (data && "browserOpen" in data) scoreBrowserOpen = Boolean(data.browserOpen);
    renderProxies();
    startScorePolling();
  } catch (error) {
    scoreStarting = false;
    scoreStartingId = "";
    scoreBrowserOpen = false;
    if (error?.code === "score_busy") {
      setScoreNotice(text.scoreBusy, "warn");
      await adoptScoreJob();
      return;
    }
    setScoreNotice(serverErrorText(error), "error");
    renderProxies();
  }
}

async function cancelScore() {
  if (scoreCancelling) return;
  scoreCancelling = true;
  renderScoreBar();
  try {
    const data = await api("api/proxy-score/cancel", { method: "POST" });
    if (data && "job" in data) scoreJob = data.job;
    else await adoptScoreJob();
    if (data && "browserOpen" in data) scoreBrowserOpen = Boolean(data.browserOpen);
    else scoreBrowserOpen = false;
  } catch (error) {
    setScoreNotice(serverErrorText(error), "error");
  } finally {
    scoreCancelling = false;
    renderProxies();
  }
  if (scoreStarting || isScoreActive(scoreJob?.state)) startScorePolling();
}

async function loadScoreStatus() {
  // A running job survives a reload in the service, so adopt it on load. A
  // missing route (an older service) is ignored rather than shown as an error.
  try {
    const data = await api("api/proxy-score");
    if (data && "job" in data) scoreJob = data.job;
    if (data && "browserOpen" in data) scoreBrowserOpen = Boolean(data.browserOpen);
  } catch {
    return;
  }
  renderProxies();
  if (isScoreActive(scoreJob?.state)) startScorePolling();
}

function providerCard(provider) {
  const card = document.createElement("article");
  card.className = "provider-card";
  card.dataset.providerId = provider.id;

  // The marker text for one method kind, in the page's language. The five
  // kinds are told apart: a known browser sign-in, a method that needs details
  // typed in, a local session, a pasted key, and a kind that is only confirmed
  // when the sign-in starts.
  function methodTagText(category) {
    return methodCategoryText(category, text);
  }

  const head = document.createElement("div");
  head.className = "provider-head";

  const mark = document.createElement("span");
  mark.className = `provider-mark tone-${provider.mark?.tone || "neutral"}`;
  mark.textContent = provider.mark?.text || String(provider.name || "?").slice(0, 1);
  mark.setAttribute("aria-hidden", "true");

  const name = document.createElement("h3");
  name.className = "provider-name";
  name.textContent = provider.name || provider.id;

  const status = providerStatusView(provider, text);
  const statusNode = document.createElement("span");
  statusNode.className = `provider-status ${status.state}`;
  statusNode.textContent = status.label;

  head.append(mark, name, statusNode);

  const description = document.createElement("p");
  description.className = "provider-description";
  description.textContent = localizedText(provider.description, langKey);

  const reason = document.createElement("p");
  reason.className = "provider-reason";
  reason.textContent = localizedText(provider.capability?.reason, langKey);

  const notice = document.createElement("p");
  notice.className = "provider-notice";
  notice.textContent = localizedText(provider.notice, langKey);

  card.append(head, description, reason);
  const presenceNode = document.createElement("p");
  presenceNode.className = "provider-presence";
  presenceNode.textContent = localizedText(provider.presenceNote, langKey);
  if (presenceNode.textContent) card.append(presenceNode);
  if (notice.textContent) card.append(notice);

  // Second layer: the sign-in methods the installed provider plugins expose.
  // The labels are shown honestly, with a per-kind marker. Five kinds are told
  // apart: a known browser sign-in, a method that needs details typed in, a
  // local session, a pasted key, and a method whose kind is only known once
  // the sign-in starts (ZCode's per-site flows). The last one is never dressed
  // up as "unknown" in the sense of "nothing found": a real method exists and
  // the page shown at sign-in is the source of truth.
  const methods = Array.isArray(provider.authMethods) ? provider.authMethods : [];
  if (methods.length) {
    const methodsNode = document.createElement("p");
    methodsNode.className = "provider-methods";
    const methodsHeading = document.createElement("span");
    methodsHeading.className = "provider-methods-heading";
    methodsHeading.textContent = text.providerMethodsHeading;
    methodsNode.append(methodsHeading);
    for (const method of methods) {
      const chip = document.createElement("span");
      const category = methodCategory(method);
      chip.className = `provider-method is-${category}`;
      const methodLabel = document.createElement("span");
      methodLabel.className = "provider-method-label";
      methodLabel.textContent = method.label || method.type || text.unknown;
      const tag = document.createElement("span");
      tag.className = "provider-method-tag";
      tag.textContent = methodTagText(category);
      chip.append(methodLabel, tag);
      methodsNode.append(chip);
    }
    card.append(methodsNode);
    // The honest note for the methods whose kind the scan cannot know.
    if (methods.some((method) => methodCategory(method) === "pending")) {
      const note = document.createElement("p");
      note.className = "provider-method-note";
      note.textContent = text.providerMethodNote;
      card.append(note);
    }
  }

  const sourceNames = [];
  if (provider.sources?.local) sourceNames.push(text.providerSourceLocal);
  if (provider.sources?.magpie) sourceNames.push(text.providerSourceMagpie);
  if (provider.pluginPackage) sourceNames.push(text.providerSourcePlugins);
  if (sourceNames.length) {
    const sourceNode = document.createElement("p");
    sourceNode.className = "provider-source-line";
    sourceNode.textContent = `${text.providerSourceLineHeading}: ${sourceNames.join(" · ")}`;
    card.append(sourceNode);
  }

  // The add-account entry. It is offered whenever the installed plugin scan
  // exposed a browser sign-in method and the merge carried the plugin entry id
  // the service loads the provider by (providerCanSignIn). Capability readiness
  // is deliberately NOT a gate: an unverified flow is exactly the one users
  // should be able to try so they can report what happens. Every control is
  // type="button" with an explicit click handler because magpie mounts the page
  // in a sandbox without allow-forms; a submit control would be silently dead.
  const actions = document.createElement("div");
  actions.className = "provider-actions";
  if (providerCanSignIn(provider)) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button primary provider-add";
    add.dataset.providerId = provider.signInProvider;
    add.textContent = text.addAccount;
    add.addEventListener("click", () => openSignInDialog(provider));
    actions.append(add);
  }
  // Reporting is offered on every card, including the ones that offer no way in
  // at all: a card with nothing to click is exactly the one worth reporting.
  const report = document.createElement("button");
  report.type = "button";
  report.className = "button provider-report";
  report.dataset.providerId = provider.id;
  report.textContent = text.reportIssue;
  report.addEventListener("click", () => openReportDialog(provider));
  actions.append(report);
  card.append(actions);

  return card;
}

// --- reporting a card ------------------------------------------------------
//
// Every card offers one way to tell us something is wrong, and the report is
// written for the user: the service assembles it from an allowlist, so nothing
// the page sends can leak a credential or widen what gets posted. The page
// cannot open a link itself (magpie's sandbox carries allow-scripts only, with
// no allow-popups), so the local service opens the finished GitHub URL in the
// system browser on the user's behalf. Nothing is posted automatically: the
// user presses Create on GitHub, having seen the whole body first.

let reportProvider = null;
let reportRequest = null;
let reportTimer = 0;
let reportSeq = 0;

function setReportError(message) {
  const node = byId("report-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setReportStatus(message) {
  const node = byId("report-status");
  node.textContent = message || "";
  node.hidden = !message;
}

async function refreshReport() {
  const seq = (reportSeq += 1);
  setReportError("");
  const note = byId("report-note").value;
  byId("report-draft").textContent = text.reportPreparing;
  try {
    const data = await api("api/report", {
      method: "POST",
      body: { provider: reportProvider, note, language: langKey },
    });
    if (seq !== reportSeq) return;
    reportRequest = data?.report ?? null;
    byId("report-draft").textContent = reportRequest?.body || "";
  } catch (error) {
    if (seq !== reportSeq) return;
    reportRequest = null;
    byId("report-draft").textContent = "";
    setReportError(serverErrorText(error));
  }
}

function scheduleReport() {
  window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    reportTimer = 0;
    refreshReport();
  }, 350);
}

function openReportDialog(provider) {
  // Only the fields the report needs cross into the dialog. Nothing else from
  // the provider object (and nothing from an account) is sent back to the
  // service, so a report can never carry more than the card already shows.
  reportProvider = {
    id: provider.id,
    name: provider.name,
    capabilityState: provider.capability?.state || provider.capabilityState,
    capabilityReason: provider.capability?.reason || provider.capabilityReason,
    description: provider.description,
    notice: provider.notice,
    authMethods: provider.authMethods,
    sources: provider.sources,
    pluginPackage: provider.pluginPackage,
  };
  reportRequest = null;
  setReportError("");
  setReportStatus("");
  byId("report-note").value = "";
  const status = providerStatusView(provider, text);
  byId("report-card").textContent = `${provider.name || provider.id} · ${status.label}`;
  const dialog = byId("report-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  refreshReport();
}

function closeReportDialog() {
  window.clearTimeout(reportTimer);
  reportTimer = 0;
  reportSeq += 1;
  const dialog = byId("report-dialog");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function copyReportBody() {
  const body = reportRequest?.body || "";
  if (!body) return;
  setReportError("");
  try {
    await navigator.clipboard.writeText(body);
    toast(text.reportCopied);
    return;
  } catch {
    // This document has an opaque origin, so the clipboard permission can be
    // refused. Fall back to selecting the draft so the text is still
    // reachable, and say so plainly if even that is blocked.
  }
  const pre = byId("report-draft");
  try {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.execCommand("copy")) {
      toast(text.reportCopied);
      return;
    }
  } catch {
    /* fall through to the honest message */
  }
  setReportError(text.reportCopyFailed);
}

async function openReportOnGitHub() {
  setReportError("");
  setReportStatus("");
  if (!reportRequest?.url) await refreshReport();
  if (!reportRequest?.url) {
    setReportError(text.reportBuildFailed);
    return;
  }
  const button = byId("report-open");
  button.disabled = true;
  try {
    await api("api/report/open", { method: "POST", body: { url: reportRequest.url } });
    setReportStatus(text.reportOpened);
  } catch (error) {
    setReportError(serverErrorText(error));
  } finally {
    button.disabled = false;
  }
}

// --- account identities ----------------------------------------------------
//
// A signed-out account keeps its directory, its profile and its pinned
// fingerprint, so the next sign-in for that credential presents the same
// machine. GET /api/accounts lists those identities (never a path, never a
// credential); DELETE /api/accounts/<provider>/<key> clears one that is not
// signed in. Every control here has a real request behind it and a visible
// outcome: loading, failure and success all say so.

function setIdentitiesError(message) {
  const node = byId("identities-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function renderIdentities() {
  const card = byId("account-identities");
  const list = byId("account-identities-list");
  const retired = accountIdentities.filter((account) => account?.signedIn !== true);
  card.hidden = false;
  byId("identities-badge").textContent = String(retired.length);
  setIdentitiesError(accountIdentitiesError);
  const notice = byId("identities-notice");
  notice.textContent = accountIdentitiesNotice || "";
  notice.hidden = !accountIdentitiesNotice;
  const retry = byId("identities-retry");
  retry.hidden = !accountIdentitiesError && !accountIdentitiesLoading;
  retry.disabled = accountIdentitiesLoading;

  list.textContent = "";
  if (accountIdentitiesLoading && !retired.length) {
    const loading = document.createElement("p");
    loading.className = "identity-empty";
    loading.textContent = text.identitiesLoading;
    list.append(loading);
    return;
  }
  if (!retired.length) {
    const empty = document.createElement("p");
    empty.className = "identity-empty";
    empty.textContent = accountIdentitiesError ? text.identitiesError : text.identitiesEmpty;
    list.append(empty);
    return;
  }
  for (const account of retired) list.append(identityRow(account));
}

// One kept identity: the account's own name, its uid, when it was last signed
// in, and the entry that clears it.
function identityRow(account) {
  const view = accountIdentityView(account);
  const row = document.createElement("div");
  row.className = "identity-row";
  row.dataset.accountKey = account.key;

  const name = document.createElement("p");
  name.className = "identity-name";
  name.textContent = view.label;
  row.append(name);

  const meta = document.createElement("span");
  meta.className = "identity-meta";
  const parts = [];
  if (view.uid && view.uid !== view.label) parts.push(view.uid);
  if (view.retiredAt) {
    parts.push(
      text.identitiesLastSignedIn.replace("{time}", formatTime(view.retiredAt)),
    );
  }
  meta.textContent = parts.join(" · ");
  row.append(meta);

  const actions = document.createElement("div");
  actions.className = "identity-actions";
  const clearing = clearingIdentityKey === account.key;
  const clear = miniButton(
    clearing ? text.identitiesClearing : text.identitiesClear,
    () => askClearIdentity(account),
    true,
  );
  clear.disabled = clearing || Boolean(clearingIdentityKey);
  actions.append(clear);
  row.append(actions);
  return row;
}

// The second confirmation: the confirm dialog asks, and only its action
// button deletes. The pending target is remembered by the confirm controller,
// so a cancelled dialog never touches anything.
function askClearIdentity(account) {
  const dialog = byId("confirm-dialog");
  if (dialog.open) return;
  confirmController.ask(account.key, accountLabel(account));
  confirmKind = "identity";
  pendingIdentity = account;
  byId("confirm-title").textContent = text.identitiesClearTitle;
  byId("confirm-copy").textContent = text.identitiesClearCopy.replace(
    "{name}",
    accountLabel(account),
  );
  byId("confirm-action").textContent = text.identitiesClearConfirm;
  setConfirmError("");
  setConfirmBusy(false);
  dialog.showModal();
}

// Deletes the identity and refreshes the list. A failure keeps the identity
// and says why.
async function clearIdentity(account) {
  if (clearingIdentityKey) return;
  clearingIdentityKey = account.key;
  accountIdentitiesError = "";
  accountIdentitiesNotice = "";
  renderIdentities();
  try {
    await api(accountIdentityPath(account.provider, account.key), { method: "DELETE" });
    clearingIdentityKey = "";
    accountIdentitiesNotice = text.identitiesCleared;
    await loadAccountIdentities();
  } catch (error) {
    clearingIdentityKey = "";
    accountIdentitiesError = accountErrorText(error);
    renderIdentities();
  }
}

// Reads the identities. A failed read is reported in the card and the list
// keeps whatever it had; it never blocks the rest of the page.
async function loadAccountIdentities() {
  accountIdentitiesLoading = true;
  accountIdentitiesError = "";
  renderIdentities();
  try {
    const data = await api("api/accounts");
    accountIdentities = Array.isArray(data?.accounts) ? data.accounts : [];
    accountIdentitiesError = "";
  } catch (error) {
    accountIdentitiesError = serverErrorText(error);
  } finally {
    accountIdentitiesLoading = false;
    renderIdentities();
    renderAccounts();
    // The counts order the main list, so the cards are laid out again once the
    // identities arrive. The split does not depend on them: no card moves
    // between the main list and the collapsed catalog.
    renderProviders(providerCatalog);
  }
}

// --- provider sign-in dialog ----------------------------------------------
//
// One dialog per provider card. It chooses a proxy from the stored list (the
// page never receives a password), starts POST /api/signin with the installed
// plugin entry id carried on the card, then polls GET /api/signin while the
// isolated browser window is open. A close while the flow is still running
// cancels it first so no invisible flow is left behind.

let signInContext = null;
let signInTimer = null;

function stopSignInPolling() {
  if (signInTimer) {
    clearTimeout(signInTimer);
    signInTimer = null;
  }
}

function startSignInPolling() {
  stopSignInPolling();
  signInTimer = setTimeout(pollSignIn, 800);
}

function setSignInNotice(message) {
  const node = byId("signin-notice");
  node.textContent = message || "";
  node.hidden = !message;
}

function setSignInError(message) {
  const node = byId("signin-error");
  node.textContent = message || "";
  node.hidden = !message;
}

// The server's exact code/message, never wrapped as an "unknown error".
function serverErrorText(error) {
  const code = error?.code ? String(error.code) : "";
  const message = error?.serverMessage ? String(error.serverMessage) : "";
  // "network" is raised by our own fetch wrapper, not by the service, and it
  // has no serverMessage. Showing that bare word in the sign-in dialog tells
  // the user nothing; it has a localized string like every other code.
  if (code === "network") return text.errorNetwork;
  return [code, message].filter(Boolean).join(" · ") || apiErrorText(error?.code);
}

function signInStateLabel(state) {
  if (state === "authorizing") return text.signInStateAuthorizing;
  if (state === "waiting-login") return text.signInStateWaiting;
  if (state === "finishing") return text.signInStateFinishing;
  if (state === "done") return text.signInStateDone;
  if (state === "error") return text.signInStateError;
  if (state === "cancelled") return text.signInStateCancelled;
  return state ? String(state) : "";
}

function renderSignIn() {
  const context = signInContext;
  if (!context) return;
  const flow = context.flow;
  const state = flow?.state || "";
  const active = signInActive(state);

  const status = byId("signin-status");
  const statusState = byId("signin-status-state");
  const statusDetail = byId("signin-status-detail");
  status.hidden = !state;
  statusState.className = `signin-status-state${state ? ` ${state}` : ""}`;
  statusState.textContent = signInStateLabel(state);

  if (state === "done") {
    statusDetail.textContent = text.signInDone;
    statusDetail.hidden = false;
  } else if (state === "error") {
    statusDetail.textContent = serverErrorText(flow?.error);
    statusDetail.hidden = false;
  } else if (state === "cancelled") {
    statusDetail.textContent = text.signInCancelled;
    statusDetail.hidden = false;
  } else {
    const warning = state === "waiting-login" ? navigationWarningText(flow?.warning, "signInNavigationWarning") : "";
    statusDetail.textContent = warning;
    statusDetail.hidden = !warning;
  }

  const result = byId("signin-result");
  if (state === "done" && flow?.accountKey) {
    result.hidden = false;
    byId("signin-result-label").textContent = text.signInAccountKey;
    byId("signin-result-key").textContent = flow.accountKey;
  } else {
    result.hidden = true;
    byId("signin-result-key").textContent = "";
  }

  byId("signin-start").hidden = active || context.busy;
  byId("signin-start").disabled = context.busy;
  byId("signin-start").textContent = context.busy ? text.signInStarting : text.signInStart;
  byId("signin-cancel").hidden = !active;
  byId("signin-cancel").disabled = context.busy;
}

function renderSignInProxies() {
  const select = byId("signin-proxy");
  select.textContent = "";
  const direct = document.createElement("option");
  direct.value = "";
  direct.textContent = text.signInProxyDirect;
  select.append(direct);
  for (const proxy of proxies) {
    const option = document.createElement("option");
    option.value = proxy.id;
    // Name plus address only; never the password (the API omits it and the page
    // never sees it).
    option.textContent = `${proxy.name || proxy.id} · ${formatAddress(proxy)}`;
    select.append(option);
  }
}

function selectedSignInProxy() {
  const id = byId("signin-proxy").value;
  return proxies.find((proxy) => proxy.id === id) || null;
}

// Re-read the stored proxies when the dialog opens so the dropdown reflects
// GET /api/proxies, not just the list bootstrap cached. A failed read keeps
// the bootstrap list; the dialog still works.
async function refreshSignInProxies() {
  try {
    const data = await api("api/proxies");
    if (Array.isArray(data?.proxies)) {
      const select = byId("signin-proxy");
      const previous = select.value;
      proxies = data.proxies;
      renderSignInProxies();
      // Preserve a choice the user already made while the read was in flight.
      select.value = proxies.some((proxy) => proxy.id === previous) ? previous : "";
    }
  } catch {
    // Keep whatever bootstrap already provided.
  }
}

// The sign-in methods a plugin offers, when it offers several. ZCode has one
// per site (Z.ai, BigModel, a team seat), and signing in to the wrong site
// yields the wrong token, so the user picks instead of the flow silently
// taking the first one. Only the label travels: it is the exact key the
// service looks the method up by.
function signInMethodOptions(provider) {
  const methods = Array.isArray(provider?.signInMethods) ? provider.signInMethods : [];
  return methods.filter((label) => typeof label === "string" && label.trim());
}

function renderSignInMethods(provider) {
  const field = byId("signin-method-field");
  const select = byId("signin-method");
  const hint = byId("signin-method-hint");
  const options = signInMethodOptions(provider);
  select.textContent = "";
  // The picker only appears when there is a real choice to make.
  if (options.length < 2) {
    field.hidden = true;
    hint.hidden = true;
    return;
  }
  for (const label of options) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    select.append(option);
  }
  field.hidden = false;
  hint.hidden = false;
  hint.textContent = text.signInMethodHint;
}

function selectedSignInMethod() {
  const field = byId("signin-method-field");
  if (!field || field.hidden) return null;
  const value = byId("signin-method").value;
  return typeof value === "string" && value ? value : null;
}

// The identities of this provider that are signed out. Continuing one of them
// reuses its fingerprint instead of drawing a new one.
function renderSignInAccounts(provider) {
  const field = byId("signin-account-field");
  const select = byId("signin-account");
  const hint = byId("signin-account-hint");
  const options = retiredAccounts(accountIdentities, provider);
  const previous = select.value;
  select.textContent = "";
  // The picker only appears when there is a real choice to make.
  if (!options.length) {
    field.hidden = true;
    hint.hidden = true;
    return;
  }
  const fresh = document.createElement("option");
  fresh.value = "";
  fresh.textContent = text.signInAccountNew;
  select.append(fresh);
  for (const account of options) {
    const option = document.createElement("option");
    option.value = account.key;
    const view = accountIdentityView(account);
    const parts = [view.label];
    if (view.retiredAt) {
      parts.push(text.identitiesLastSignedIn.replace("{time}", formatTime(view.retiredAt)));
    }
    option.textContent = parts.join(" · ");
    select.append(option);
  }
  // Keep a choice the user already made while the list was being re-read;
  // otherwise a provider with exactly one kept identity preselects it.
  const available = new Set(options.map((account) => account.key));
  select.value = available.has(previous)
    ? previous
    : defaultAccountKey(accountIdentities, provider);
  field.hidden = false;
  hint.hidden = false;
  hint.textContent = text.signInAccountHint;
}

// The identity the user picked, or null for a fresh account.
function selectedSignInAccount() {
  const field = byId("signin-account-field");
  if (!field || field.hidden) return null;
  const value = byId("signin-account").value;
  return typeof value === "string" && value ? value : null;
}

function openSignInDialog(provider, options = {}) {
  const dialog = byId("signin-dialog");
  // A signed-out account row reuses the same dialog. The provider comes from
  // the real bootstrap list; if it is not listed any more the account still
  // carries a real provider id and the service decides whether it can sign in.
  if (typeof provider === "string") {
    const id = provider;
    provider = accountProviderEntry(id) || {
      signInProvider: id,
      name: id,
      signInMethods: [],
      browserMethod: true,
      signableMethod: true,
    };
  }
  if (dialog.open || !providerCanSignIn(provider)) return;
  signInContext = {
    provider: provider.signInProvider,
    name: provider.name || provider.signInProvider,
    preselectAccountKey: typeof options.accountKey === "string" ? options.accountKey : "",
    flow: null,
    busy: false,
  };
  byId("signin-provider").textContent = signInContext.name;
  renderSignInMethods(provider);
  renderSignInAccounts(provider);
  renderSignInProxies();
  renderSignInPreselection();
  byId("signin-proxy").value = "";
  setSignInNotice("");
  setSignInError("");
  renderSignIn();
  dialog.showModal();
  byId("signin-start").focus();
  refreshSignInProxies();
  // The identity list is re-read when the dialog opens: an identity may have
  // been retired (or cleared) since the page loaded.
  loadAccountIdentities().then(() => {
    if (!signInContext) return;
    renderSignInAccounts(signInContext.provider);
    renderSignInPreselection();
  });
}

// The account row's "sign in again" action preselects the kept identity, so
// the next sign-in reuses that fingerprint instead of drawing a new one.
function renderSignInPreselection() {
  const key = signInContext?.preselectAccountKey || "";
  if (!key) return;
  const field = byId("signin-account-field");
  const select = byId("signin-account");
  const hint = byId("signin-account-hint");
  if (![...select.options].some((option) => option.value === key)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = accountLabel(
      accountIdentities.find((item) => item?.key === key) || { key },
    );
    select.append(option);
  }
  select.value = key;
  field.hidden = false;
  hint.hidden = false;
  hint.textContent = text.signInAccountHint;
}

async function startSignIn() {
  const context = signInContext;
  if (!context || context.busy) return;
  context.busy = true;
  setSignInError("");
  setSignInNotice("");
  renderSignIn();
  try {
    await api("api/signin", {
      method: "POST",
      body: signInPayload(
        context.provider,
        selectedSignInProxy(),
        selectedSignInMethod(),
        selectedSignInAccount(),
      ),
    });
    if (signInContext !== context) return;
    context.busy = false;
    // startSignIn answers only after the browser window is open.
    context.flow = { state: "waiting-login", accountKey: null };
    setSignInNotice(text.signInOpened);
    renderSignIn();
    startSignInPolling();
  } catch (error) {
    if (signInContext !== context) return;
    context.busy = false;
    setSignInError(serverErrorText(error));
    renderSignIn();
  }
}

async function pollSignIn() {
  signInTimer = null;
  const context = signInContext;
  if (!context || !byId("signin-dialog").open) return;
  const previousState = context.flow?.state || "";
  try {
    const data = await api("api/signin");
    if (signInContext !== context) return;
    if (data?.flow) context.flow = data.flow;
  } catch (error) {
    if (signInContext !== context) return;
    setSignInError(serverErrorText(error));
    renderSignIn();
    return;
  }
  renderSignIn();
  const state = context.flow?.state || "";
  if (state === "done" && previousState !== "done") {
    // The account is signed in again, so it is no longer a retired identity.
    loadAccountIdentities().then(() => {
      if (signInContext) renderSignInAccounts(signInContext.provider);
    });
  }
  if (signInContext === context && signInActive(state)) {
    startSignInPolling();
  }
}

async function cancelSignIn() {
  const context = signInContext;
  if (!context) return;
  context.busy = true;
  renderSignIn();
  try {
    const data = await api("api/signin/cancel", { method: "POST" });
    if (signInContext !== context) return;
    context.flow = data?.flow || { ...(context.flow || {}), state: "cancelled" };
    context.busy = false;
    stopSignInPolling();
    renderSignIn();
  } catch (error) {
    if (signInContext !== context) return;
    context.busy = false;
    setSignInError(serverErrorText(error));
    renderSignIn();
  }
}

function cleanupSignInDialog() {
  stopSignInPolling();
  signInContext = null;
  setSignInNotice("");
  setSignInError("");
  byId("signin-result").hidden = true;
  byId("signin-result-key").textContent = "";
  byId("signin-status").hidden = true;
}

function closeSignInDialog() {
  const dialog = byId("signin-dialog");
  if (signInContext && signInActive(signInContext.flow?.state)) {
    // Cancel first, then close: closing must never leave a running flow that
    // the user can no longer see.
    cancelSignIn().finally(() => {
      if (byId("signin-dialog").open) byId("signin-dialog").close();
      else cleanupSignInDialog();
    });
    return;
  }
  if (dialog.open) dialog.close();
  else cleanupSignInDialog();
}

// The launcher forwards magpie's provider list in the navigation hash. It is
// untrusted input: a bad parse falls back to the local list. The raw payload
// is posted to the service for normalization; the real shape of
// `providers:list` has not been verified on this machine.
function magpiePayloadFromHash() {
  try {
    const raw = new URLSearchParams(String(location.hash || "").replace(/^#/, "")).get("providers");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pluginScanNote(plugins) {
  if (plugins?.available) {
    return text.providerPluginsFound
      .replace("{count}", String(plugins.count ?? 0))
      .replace("{browser}", String(plugins.browserMethods ?? 0));
  }
  if (plugins?.pollGaveUp) return text.providerPluginsScanTimedOut;
  if (plugins?.scanning || plugins?.stale) return text.providerPluginsScanning;
  // A scan that reported an error is a FAILED scan, not an absent feature:
  // name the failure and quote the service's own diagnostic. "unavailable" is
  // kept for a scan that never produced an error at all.
  if (plugins?.error) {
    return text.providerPluginsFailed.replace("{error}", String(plugins.error).slice(0, 200));
  }
  return text.providerPluginsUnavailable;
}

// The add entries on the cards come from the installed-plugin scan, and the
// service starts that scan on the first /api/provider-sources read. The first
// answer is produced while the scan child is still running (`scanning: true`),
// so its cards carry no sign-in methods; without a follow-up read the page
// would keep saying "Scanning installed plugins…" with no entry until the user
// reloaded by hand.
//
// So the page follows the scan on a bounded schedule. The loop is independent
// of the sign-in and score timers, never stacks a request on an in-flight one,
// pauses while the page is hidden, and gives up with an honest note instead of
// claiming a live scan forever.
let pluginScanPoll = null;
let providerSourcesView = null;

function stopPluginScanPolling() {
  const poll = pluginScanPoll;
  pluginScanPoll = null;
  if (!poll) return;
  poll.guard.cancel();
  if (poll.timer) clearTimeout(poll.timer);
}

function applyProviderSources(view) {
  providerSourcesView = view;
  const providers = view && Array.isArray(view.providers) ? view.providers : [];
  renderProviders(providers);
  renderProviderSources(view);
}

// The scan did not settle inside the poll budget. Stop and say so: leaving the
// "scanning" note up would claim a scan that may no longer be running.
function abandonPluginScanPolling() {
  stopPluginScanPolling();
  if (!providerSourcesView) return;
  applyProviderSources({
    ...providerSourcesView,
    plugins: { ...(providerSourcesView.plugins || {}), scanning: false, pollGaveUp: true },
  });
}

function schedulePluginScanPoll() {
  if (!pluginScanPoll || pluginScanPoll.inflight) return;
  pluginScanPoll.timer = setTimeout(runPluginScanPoll, PLUGIN_SCAN_POLL_INTERVAL_MS);
}

async function runPluginScanPoll() {
  const poll = pluginScanPoll;
  if (!poll || poll.inflight) return;
  poll.timer = null;
  // A hidden page must not keep the service busy. The visibilitychange handler
  // continues the same bounded budget once the page is visible again.
  if (document.hidden) return;
  if (poll.attempts >= PLUGIN_SCAN_POLL_MAX_ATTEMPTS) {
    abandonPluginScanPolling();
    return;
  }
  poll.attempts += 1;
  poll.inflight = true;
  const token = poll.guard.begin();
  let merged = null;
  try {
    merged = await api("api/provider-sources", {
      method: "POST",
      body: { magpie: magpiePayloadFromHash() },
    });
  } catch {
    merged = null;
  }
  // A newer load() (or a stopped loop) owns the state now; a late answer from
  // this request must not touch it.
  if (pluginScanPoll !== poll || !poll.guard.isCurrent(token)) return;
  poll.inflight = false;
  if (!merged || !merged.providerSources) {
    // One failed read must not freeze the cards on "scanning": retry until the
    // budget runs out.
    schedulePluginScanPoll();
    return;
  }
  const view = {
    ...merged.providerSources,
    plugins: { ...(merged.providerSources.plugins || {}), ...(merged.pluginScan || {}) },
  };
  applyProviderSources(view);
  if (shouldPollPluginScan(view.plugins)) schedulePluginScanPoll();
  else stopPluginScanPolling();
}

function startPluginScanPolling() {
  stopPluginScanPolling();
  if (!shouldPollPluginScan(providerSourcesView?.plugins)) return;
  const guard = createRequestGuard();
  pluginScanPoll = { guard, attempts: 0, inflight: false, timer: null };
  schedulePluginScanPoll();
}

function renderProviderSources(view) {
  const node = byId("provider-sources");
  if (!node) return;
  if (!view) {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  const fromMagpie = view.source === "magpie";
  const badge = byId("provider-sources-badge");
  badge.textContent = fromMagpie ? text.providersSourceMagpie : text.providersSourceLocal;
  badge.dataset.source = fromMagpie ? "magpie" : "local";
  const note = byId("provider-sources-note");
  const pluginNote = pluginScanNote(view.plugins);
  if (!fromMagpie) {
    note.textContent = `${text.providersDiffUnavailable} · ${pluginNote}`;
    return;
  }
  const counts = view.counts || {};
  const differences = (Number(counts.localOnly) || 0) + (Number(counts.magpieOnly) || 0);
  const diffNote = differences === 0
    ? text.providersDiffNone
    : text.providersDiff
        .replace("{both}", String(counts.both ?? 0))
        .replace("{localOnly}", String(counts.localOnly ?? 0))
        .replace("{magpieOnly}", String(counts.magpieOnly ?? 0));
  note.textContent = `${diffNote} · ${pluginNote}`;
}

// How many accounts each provider has, from the identities read. The count only
// orders the main list, so a pending or failed read leaves the order the
// service sent instead of blocking the cards.
function accountCounts() {
  const counts = {};
  for (const account of Array.isArray(accountIdentities) ? accountIdentities : []) {
    const id = typeof account?.provider === "string" ? account.provider : "";
    if (!id) continue;
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

// The page has two regions and only two: the main list of providers a user can
// sign in to right now (the ones with the most accounts first), and one
// collapsed catalog holding every other subscription provider the local data
// knows about, so no subscription service quietly disappears from the page.
// The split itself is pure and lives in ui/provider-state.js.
function renderProviders(items) {
  providerCatalog = Array.isArray(items) ? items : [];
  const list = byId("providers-list");
  const more = byId("providers-more");
  const moreList = byId("providers-more-list");
  const empty = byId("providers-empty");
  byId("provider-count").textContent = String(providerCatalog.length);
  const { primary, other } = partitionProviders(providerCatalog, accountCounts());
  empty.hidden = primary.length + other.length > 0;
  list.hidden = primary.length === 0;
  list.textContent = "";
  for (const provider of primary) list.append(providerCard(provider));
  if (!more) return;
  more.hidden = other.length === 0;
  byId("providers-more-count").textContent = String(other.length);
  moreList.textContent = "";
  for (const provider of other) moreList.append(providerCard(provider));
}

function render(data) {
  const view = data?.providerSources;
  providerSourcesView = view || null;
  const providers = view && Array.isArray(view.providers)
    ? view.providers
    : Array.isArray(data?.providers) ? data.providers : [];
  proxies = Array.isArray(data?.proxies) ? data.proxies : [];
  checkProxies = proxies;
  renderProviders(providers);
  renderProviderSources(view);
  renderProxies();
  byId("version").textContent = data?.version ? `v${data.version}` : "";
  const ready = data?.service?.status === "ready";
  setServiceState(ready ? "ready" : "error", ready ? text.ready : text.failed);
  byId("retry").hidden = ready;
}

// --- one-time login browser setup -----------------------------------------
//
// The setup card is driven entirely by /api/environment. It is shown for as
// long as the API has answered (missing/preparing/ready/error/cancelled), so
// the user can always see where the browser lives and how the download was
// verified; in the ready state it carries a Ready badge and no action button.
// While a prepare job is running the page polls /api/environment/job until the
// phase leaves preparing, then every control except the one that fits the
// settled state is hidden, so the card never keeps an inert button around.

function environmentBadgeFor(phase) {
  if (phase === "ready") return text.environmentBadgeReady;
  if (phase === "preparing") return text.environmentBadgePreparing;
  if (phase === "error") return text.environmentBadgeError;
  if (phase === "cancelled") return text.environmentBadgeCancelled;
  return text.environmentBadgeMissing;
}

// The default asset ships a published sha256 that defaultInstaller always
// enforces, so it is verified even before the first install. An override only
// counts as verified once its own digest matches; an override without a
// digest stays unverified. The manager may report this as a boolean or as a
// status string, so both shapes are accepted.
function environmentChecksumVerified(env) {
  if (env?.checksumVerified === true) return true;
  const status = String(env?.checksumStatus || "").toLowerCase();
  if (status === "verified" || status === "ok" || status === "published") return true;
  return env?.assetOverride === false;
}

function environmentRequestErrorText(error) {
  const code = error?.code;
  if (code && environmentErrorKeys[code]) return text[environmentErrorKeys[code]];
  return apiErrorText(code);
}

function stopEnvironmentPolling() {
  if (environmentTimer) {
    clearTimeout(environmentTimer);
    environmentTimer = null;
  }
}

function startEnvironmentPolling() {
  stopEnvironmentPolling();
  environmentTimer = setTimeout(pollEnvironment, 1000);
}

async function pollEnvironment() {
  environmentTimer = null;
  if (!environment || environmentPhase(environment, environmentJob) !== "preparing") return;
  try {
    const data = await api("api/environment/job");
    if (data?.environment) environment = data.environment;
    if (data && "job" in data) environmentJob = data.job;
    environmentRequestError = "";
  } catch (error) {
    // One dropped poll must not stop the loop; the next tick retries.
    environmentRequestError = environmentRequestErrorText(error);
  }
  renderEnvironment();
}

function renderEnvironment() {
  const card = byId("environment-setup");
  if (!environment) {
    card.hidden = true;
    stopEnvironmentPolling();
    return;
  }
  const phase = environmentPhase(environment, environmentJob);
  card.hidden = false;

  const badge = byId("environment-badge");
  badge.textContent = environmentBadgeFor(phase);
  badge.dataset.state = phase;

  byId("environment-size-value").textContent = text.environmentSizeValue
    .replace("{size}", formatBytes(environment.downloadBytes) || text.unknown)
    .replace("{extracted}", formatBytes(environment.extractedBytes) || text.unknown);
  byId("environment-disk-value").textContent = text.environmentDiskValue
    .replace("{free}", formatBytes(environment.freeBytes) || text.unknown)
    .replace("{required}", formatBytes(environment.requiredDiskBytes) || text.unknown);
  byId("environment-location-value").textContent = environment.installDir || text.unknown;

  const checksumNote = environmentChecksumVerified(environment)
    ? text.environmentChecksumVerified
    : text.environmentChecksumUnverified;
  byId("environment-note").textContent = `${text.environmentNote} ${checksumNote}`;

  const progress = environmentJob?.progress || {};
  const percent = environmentPercent(environment, environmentJob);
  const received = Number(progress.receivedBytes) || 0;
  const total = Number(progress.totalBytes) || Number(environment.downloadBytes) || 0;
  const preparing = phase === "preparing";
  byId("environment-progress").hidden = !preparing;
  byId("environment-progress-bar").style.width = `${percent}%`;
  byId("environment-progress-text").textContent = text.environmentProgress
    .replace("{percent}", String(percent))
    .replace("{received}", formatBytes(received) || text.unknown)
    .replace("{total}", formatBytes(total) || text.unknown);

  const errorText = phase === "error"
    ? environmentErrorText(environmentJob?.error?.code)
    : environmentRequestError;
  const errorNode = byId("environment-error");
  errorNode.textContent = errorText || "";
  errorNode.hidden = !errorText;

  const prepare = byId("environment-prepare");
  const cancel = byId("environment-cancel");
  const retry = byId("environment-retry");
  prepare.hidden = phase !== "missing";
  cancel.hidden = !preparing;
  retry.hidden = phase !== "error" && phase !== "cancelled";
  prepare.disabled = environmentBusy;
  cancel.disabled = environmentBusy;
  retry.disabled = environmentBusy;

  if (preparing) {
    if (!environmentTimer) startEnvironmentPolling();
  } else {
    stopEnvironmentPolling();
  }
}

async function prepareEnvironment() {
  if (environmentBusy) return;
  environmentBusy = true;
  environmentRequestError = "";
  renderEnvironment();
  try {
    const data = await api("api/environment/prepare", { method: "POST" });
    if (data?.environment) environment = data.environment;
    if (data && "job" in data) environmentJob = data.job;
  } catch (error) {
    environmentRequestError = environmentRequestErrorText(error);
  } finally {
    environmentBusy = false;
    renderEnvironment();
  }
}

async function cancelEnvironment() {
  if (environmentBusy) return;
  environmentBusy = true;
  renderEnvironment();
  try {
    const data = await api("api/environment/cancel", { method: "POST" });
    if (data?.environment) environment = data.environment;
    if (data && "job" in data) environmentJob = data.job;
    environmentRequestError = "";
  } catch (error) {
    environmentRequestError = environmentRequestErrorText(error);
  } finally {
    environmentBusy = false;
    renderEnvironment();
  }
}

async function loadEnvironment() {
  try {
    const data = await api("api/environment");
    environment = data?.environment || null;
    environmentJob = data?.job ?? null;
    environmentRequestError = "";
  } catch {
    // The environment card is optional; a failed read keeps it hidden.
    environment = null;
    environmentJob = null;
    environmentRequestError = "";
  }
  renderEnvironment();
}

// The service binds in the background now, so the page can load before the
// port is listening. Keep retrying a failed bootstrap instead of leaving the
// account UI stuck on "error" until the user clicks Retry.
let loadRetryTimer = null;
let loadRetryCount = 0;
const LOAD_RETRY_LIMIT = 120;
const LOAD_RETRY_DELAY_MS = 1500;

async function load() {
  if (loadRetryTimer !== null) {
    clearTimeout(loadRetryTimer);
    loadRetryTimer = null;
  }
  setServiceState("connecting", text.connecting);
  byId("retry").hidden = true;
  // A retry restarts the plugin-scan follow-up from scratch instead of leaving
  // the previous loop running beside it.
  stopPluginScanPolling();
  try {
    // Relative so it also works when magpie web mounts the service under a
    // path of its own address (magpie.service) for remote viewers.
    const data = await api("api/bootstrap");
    let providerSources = null;
    try {
      const merged = await api("api/provider-sources", {
        method: "POST",
        body: { magpie: magpiePayloadFromHash() },
      });
      providerSources = merged?.providerSources ?? null;
      // The merge result carries the plugin counts; the live scan state
      // (first scan in flight, stale cache) arrives beside it. Fold the two so
      // the source banner can say "scanning" honestly instead of "unavailable".
      if (providerSources && merged?.pluginScan) {
        providerSources.plugins = { ...providerSources.plugins, ...merged.pluginScan };
      }
    } catch {
      // The merge is an enhancement over the local bootstrap cards; a failed
      // call keeps those cards and hides the source banner.
      providerSources = null;
    }
    render({ ...data, providerSources });
    // The first provider-sources read starts the installed-plugin scan and
    // answers while it is still running; follow it so the cards gain their add
    // entries without a manual page reload.
    startPluginScanPolling();
    // The token is valid again, so clear the reload marker left by the one
    // automatic reload; the launcher's theme/lang and the hash stay intact.
    reloadGuard.clearMarker();
    loadEnvironment();
    loadScoreStatus();
    loadAccountIdentities();
    loadRetryCount = 0;
  } catch (error) {
    // A refused connection is transient while the service takes the port over,
    // so retry it quietly instead of declaring the service dead. A token that
    // is no longer valid is reloaded by the api layer and must not be retried.
    if (error?.code !== "unauthorized" && loadRetryCount < LOAD_RETRY_LIMIT) {
      loadRetryCount += 1;
      loadRetryTimer = setTimeout(() => {
        loadRetryTimer = null;
        load();
      }, LOAD_RETRY_DELAY_MS);
      return;
    }
    loadRetryCount = 0;
    setServiceState("error", text.failed);
    byId("retry").hidden = false;
  }
}

function cancelRowTest(id) {
  const entry = rowTests.get(id);
  if (!entry) return;
  entry.guard.cancel();
  entry.controller.abort();
  rowTests.delete(id);
}

async function testRowProxy(id) {
  const proxy = proxies.find((item) => item.id === id);
  if (!proxy || rowTests.has(id)) return;
  const guard = createRequestGuard();
  const controller = new AbortController();
  const tokenForTest = guard.begin();
  rowTests.set(id, { guard, controller });
  renderProxies();
  try {
    const data = await api(`api/proxies/${encodeURIComponent(id)}/test`, {
      method: "POST",
      signal: controller.signal,
    });
    const active = rowTests.get(id);
    if (!active || active.guard !== guard || !guard.isCurrent(tokenForTest)) return;
    rowTests.delete(id);
    // A null proxy means the row was edited or removed while the probe ran;
    // the stale result must not be applied to the new state.
    if (data?.proxy) replaceProxy(data.proxy);
    renderProxies();
  } catch (error) {
    if (error?.name === "AbortError") return;
    const active = rowTests.get(id);
    if (!active || active.guard !== guard || !guard.isCurrent(tokenForTest)) return;
    rowTests.delete(id);
    const current = proxies.find((item) => item.id === id);
    if (current) {
      current.status = "error";
      current.errorCode = "network";
      current.error = text.errorNetwork;
      current.latency = null;
      current.lastCheckedAt = new Date().toISOString();
      current.updatedAt = current.lastCheckedAt;
    }
    renderProxies();
  }
}

function dialogValues() {
  return normalizeProxyForm({
    name: byId("proxy-name").value,
    type: byId("proxy-type").value,
    host: byId("proxy-host").value,
    port: byId("proxy-port").value,
    username: byId("proxy-username").value,
    password: byId("proxy-password").value,
  });
}

function validationError(values, requireName) {
  if (requireName && !values.name) return { key: "nameRequired", field: "proxy-name" };
  if (values.name && /[\u0000-\u001f\u007f]/.test(values.name)) {
    return { key: "nameInvalid", field: "proxy-name" };
  }
  if (values.name.length > 80) return { key: "nameTooLong", field: "proxy-name" };
  if (!["http", "https", "socks5"].includes(values.type)) {
    return { key: "typeInvalid", field: "proxy-type" };
  }
  if (!values.host) return { key: "hostRequired", field: "proxy-host" };
  if (values.host.length > 255 || /[\s\u0000-\u001f\u007f]/.test(values.host)) {
    return { key: "hostInvalid", field: "proxy-host" };
  }
  if (!/^\d{1,5}$/.test(values.port) || Number(values.port) < 1 || Number(values.port) > 65535) {
    return { key: "portInvalid", field: "proxy-port" };
  }
  if (values.username.length > 255 || /[\u0000-\u001f\u007f]/.test(values.username)) {
    return {
      key: values.username.length > 255 ? "usernameTooLong" : "usernameInvalid",
      field: "proxy-username",
    };
  }
  if (values.password.length > 255 || /\u0000/.test(values.password)) {
    return {
      key: values.password.length > 255 ? "passwordTooLong" : "passwordInvalid",
      field: "proxy-password",
    };
  }
  return null;
}

function showValidationError(error) {
  if (!error) return false;
  setFormError(text[error.key]);
  byId(error.field)?.focus();
  return true;
}

function payloadFor(values) {
  const payload = {
    name: values.name,
    type: values.type,
    host: values.host,
    port: Number(values.port),
    username: values.username,
  };
  if (values.password) payload.password = values.password;
  return payload;
}

function setDialogBusy(busy) {
  byId("test-proxy").disabled = busy;
  byId("save-proxy").disabled = busy;
  byId("test-proxy").textContent = busy && dialogContext?.testing
    ? text.testing
    : text.testConnection;
  byId("save-proxy").textContent = busy && dialogContext?.saving ? text.saving : text.save;
}

function cancelDialogTest() {
  const context = dialogContext;
  if (!context) return;
  context.testGuard.cancel();
  context.testAbort?.abort();
  context.testAbort = null;
  context.testing = false;
}

function cleanupProxyDialog() {
  const context = dialogContext;
  dialogContext = null;
  if (context) {
    context.testGuard.cancel();
    context.testAbort?.abort();
  }
  setFormError("");
  clearTestResult();
  setDialogBusy(false);
}

function openProxyDialog(proxy = null) {
  const dialog = byId("proxy-dialog");
  if (dialog.open) return;
  byId("proxy-form").reset();
  setFormError("");
  clearTestResult();
  dialogContext = {
    mode: proxy ? "edit" : "create",
    id: proxy?.id || "",
    testGuard: createRequestGuard(),
    testAbort: null,
    testing: false,
    saving: false,
    lastTest: null,
  };
  byId("proxy-dialog-title").textContent = proxy ? text.editProxyTitle : text.addProxyTitle;
  byId("proxy-name").value = proxy?.name || "";
  byId("proxy-type").value = proxy?.type || "http";
  byId("proxy-host").value = proxy?.host || "";
  byId("proxy-port").value = proxy?.port != null ? String(proxy.port) : "";
  byId("proxy-username").value = proxy?.username || "";
  byId("proxy-password").value = "";
  const hint = byId("proxy-password-hint");
  if (proxy?.hasPassword) {
    hint.textContent = text.passwordKeepHint;
    hint.hidden = false;
  } else {
    hint.textContent = "";
    hint.hidden = true;
  }
  setDialogBusy(false);
  dialog.showModal();
  byId("proxy-name").focus();
}

function closeProxyDialog() {
  const dialog = byId("proxy-dialog");
  if (dialog.open) dialog.close();
  else cleanupProxyDialog();
}

function showTestResult(result) {
  if (!result) {
    setTestResult("error", text.testFailure.replace("{error}", text.testUnknown));
    return;
  }
  if (result.ok) {
    setTestResult(
      "ok",
      text.testSuccess
        .replace("{ip}", result.exitIp || text.unknown)
        .replace("{region}", result.region || text.unknown)
        .replace("{latency}", String(result.latency ?? "?")),
    );
    return;
  }
  setTestResult("error", text.testFailure.replace("{error}", testErrorText(result)));
}

async function testDialogProxy() {
  const context = dialogContext;
  if (!context || context.testing || context.saving) return;
  const values = dialogValues();
  if (showValidationError(validationError(values, false))) return;
  context.testAbort?.abort();
  context.testGuard.cancel();
  context.lastTest = null;
  clearTestResult();
  setTestResult("", text.testing);
  context.testing = true;
  setDialogBusy(true);
  const guard = context.testGuard;
  const tokenForTest = guard.begin();
  const controller = new AbortController();
  context.testAbort = controller;
  try {
    const data = context.mode === "edit"
      ? await api(`api/proxies/${encodeURIComponent(context.id)}/test`, {
          method: "POST",
          body: payloadFor(values),
          signal: controller.signal,
        })
      : await api("api/proxies/test", {
          method: "POST",
          body: payloadFor(values),
          signal: controller.signal,
        });
    if (dialogContext !== context || !guard.isCurrent(tokenForTest) || !byId("proxy-dialog").open) {
      return;
    }
    context.lastTest = {
      fingerprint: proxyFingerprint(values),
      ok: Boolean(data?.ok),
      result: data?.result || null,
    };
    if (data?.proxy) replaceProxy(data.proxy);
    renderProxies();
    showTestResult(data?.result);
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (dialogContext !== context || !guard.isCurrent(tokenForTest) || !byId("proxy-dialog").open) {
      return;
    }
    context.lastTest = null;
    setTestResult("error", text.testFailure.replace("{error}", apiErrorText(error.code)));
  } finally {
    if (dialogContext === context) {
      context.testing = false;
      context.testAbort = null;
      if (byId("proxy-dialog").open) setDialogBusy(false);
    }
  }
}

async function saveProxy() {
  const context = dialogContext;
  if (!context || context.saving) return;
  const values = dialogValues();
  if (showValidationError(validationError(values, true))) return;
  context.saving = true;
  setFormError("");
  setDialogBusy(true);
  try {
    const payload = payloadFor(values);
    const data = context.mode === "edit"
      ? await api(`api/proxies/${encodeURIComponent(context.id)}`, { method: "PATCH", body: payload })
      : await api("api/proxies", { method: "POST", body: payload });
    if (!data?.proxy) {
      const error = new Error("invalid response");
      error.code = "internal";
      throw error;
    }
    const saved = data.proxy;
    const lastTest = context.lastTest;
    const testedValues = lastTest && lastTest.ok && lastTest.fingerprint === proxyFingerprint(values);
    if (context.mode === "edit") cancelRowTest(context.id);
    replaceProxy(saved);
    if (byId("proxy-dialog").open) closeProxyDialog();
    renderProxies();
    // A dialog test checks the draft connection. After Save, run the real row
    // test so the list reflects the saved revision.
    if (testedValues && saved.status !== "ok") testRowProxy(saved.id);
  } catch (error) {
    if (dialogContext === context && byId("proxy-dialog").open) {
      setFormError(apiErrorText(error.code));
      context.saving = false;
      setDialogBusy(false);
    }
  }
}

function askDelete(proxy) {
  const dialog = byId("confirm-dialog");
  if (dialog.open) return;
  const target = confirmController.ask(proxy.id, proxy.name);
  confirmKind = "proxy";
  pendingIdentity = null;
  byId("confirm-title").textContent = text.deleteTitle;
  byId("confirm-copy").textContent = text.deleteCopy.replace("{name}", target.name);
  byId("confirm-action").textContent = text.deleteConfirm;
  setConfirmError("");
  setConfirmBusy(false);
  dialog.showModal();
}

function setConfirmBusy(busy) {
  byId("confirm-action").disabled = busy;
  byId("confirm-cancel").disabled = busy;
  byId("confirm-close").disabled = busy;
}

function cleanupConfirmDialog() {
  if (!deleting) confirmController.cancel();
  confirmKind = "proxy";
  pendingIdentity = null;
  setConfirmError("");
  setConfirmBusy(false);
}

function closeConfirmDialog() {
  const dialog = byId("confirm-dialog");
  if (dialog.open) dialog.close();
  else cleanupConfirmDialog();
}

async function confirmDelete() {
  if (deleting) return;
  const target = confirmController.peek();
  if (!target) return;
  if (confirmKind === "identity") {
    const account = pendingIdentity;
    confirmKind = "proxy";
    pendingIdentity = null;
    confirmController.take(target.id);
    if (byId("confirm-dialog").open) byId("confirm-dialog").close();
    if (account) await clearIdentity(account);
    return;
  }
  deleting = true;
  setConfirmBusy(true);
  setConfirmError("");
  try {
    await api(`api/proxies/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    confirmController.take(target.id);
    cancelRowTest(target.id);
    proxies = proxies.filter((item) => item.id !== target.id);
    deleting = false;
    if (byId("confirm-dialog").open) byId("confirm-dialog").close();
    else cleanupConfirmDialog();
    renderProxies();
  } catch (error) {
    deleting = false;
    if (byId("confirm-dialog").open) {
      setConfirmError(apiErrorText(error.code));
      setConfirmBusy(false);
    } else {
      confirmController.cancel();
    }
  }
}

// --- accounts page -------------------------------------------------------
//
// Everything in the accounts table comes from GET /api/accounts — the same
// unified list the sign-in dialog uses. There is no local seed and no local
// verdict: a failed or cancelled check writes nothing, so the page re-reads
// the list after every settled job and renders exactly what the service says.

function accountProviderEntry(provider) {
  return providerCatalog.find(
    (item) => item?.signInProvider === provider || item?.id === provider,
  ) || null;
}

function accountDisplay(account) {
  const view = accountView(account);
  const entry = accountProviderEntry(view.provider);
  return accountView({ ...account, providerLabel: entry?.name || view.providerLabel || view.provider });
}

// An account is flagged when the provider's own sign-in capability has not
// been verified yet (or the ledger itself says so). No hard-coded account is
// ever marked: both sources are real API data.
function accountUnverified(account) {
  if (account?.unverified === true) return true;
  const view = accountView(account);
  const entry = accountProviderEntry(view.provider);
  if (!entry) return false;
  return providerStatusView(entry, text).state !== "ready";
}

function gradeTone(grade) {
  if (grade === "A" || grade === "B") return "good";
  if (grade === "C") return "warn";
  if (grade === "D") return "bad";
  return "none";
}

function accountCell(className, label) {
  const cell = document.createElement("div");
  cell.className = className;
  // The mobile card layout shows this as a field label; the desktop grid
  // hides the ::before rule.
  cell.setAttribute("data-label", label);
  return cell;
}

function accountRunningFor(provider, key) {
  return Boolean(
    accountCheckContext?.active &&
    accountCheckContext.provider === provider &&
    accountCheckContext.key === key,
  );
}

function accountRow(account) {
  const view = accountDisplay(account);
  const row = document.createElement("div");
  row.className = "proxy-row account-row";
  row.dataset.accountKey = view.key;
  row.dataset.provider = view.provider;

  const name = accountCell("proxy-name account-cell-name", text.accountColName);
  const line = document.createElement("div");
  line.className = "account-name-line";
  const strong = document.createElement("strong");
  strong.textContent = view.name;
  line.append(strong);
  if (accountUnverified(account)) {
    const tag = document.createElement("span");
    tag.className = "unverified-tag";
    tag.textContent = text.accountUnverified;
    tag.title = text.accountUnverifiedTitle;
    line.append(tag);
  }
  const small = document.createElement("small");
  small.textContent = `${view.providerLabel} · ${view.key}`;
  name.append(line, small);

  const fingerprint = accountCell(
    "proxy-address account-fingerprint account-cell-fingerprint",
    text.accountColFingerprint,
  );
  fingerprint.append(document.createTextNode(view.fingerprint.id || text.accountFingerprintNone));
  const pinned = document.createElement("small");
  pinned.textContent = text.accountFingerprintPinned
    .replace("{time}", formatTime(view.fingerprint.pinnedAt));
  fingerprint.append(pinned);

  const lastLogin = accountCell("proxy-checked account-cell-last-login", text.accountColLastLogin);
  lastLogin.textContent = text.accountLastLoginAt
    .replace("{time}", formatTime(view.lastLogin?.at || view.signedInAt))
    .replace("{exit}", formatExit(view.lastLogin, text.accountExitDirect));

  const checkCell = accountCell("proxy-score-cell account-cell-check", text.accountColCheck);
  if (accountRunningFor(view.provider, view.key)) {
    const running = document.createElement("span");
    running.className = "proxy-score is-active";
    running.textContent = text.accountChecking;
    checkCell.append(running);
  } else if (!view.lastCheck) {
    const none = document.createElement("span");
    none.className = "proxy-score none";
    none.textContent = text.accountCheckNone;
    checkCell.append(none);
  } else {
    const grade = document.createElement("span");
    grade.className = `proxy-score ${gradeTone(view.lastCheck.grade)}`;
    grade.textContent = String(view.lastCheck.grade || "—");
    const when = document.createElement("small");
    when.className = "proxy-score-label";
    when.textContent = formatTime(view.lastCheck.at);
    checkCell.append(grade, when);
  }

  const statusCell = accountCell("proxy-status-cell account-cell-status", text.accountColStatus);
  const status = document.createElement("span");
  status.className = `proxy-status${view.signedIn ? " ok" : ""}`;
  status.textContent = view.signedIn ? text.accountSignedIn : text.accountSignedOut;
  statusCell.append(status);

  const actions = accountCell("proxy-actions account-cell-actions", text.accountColActions);
  const busy = Boolean(accountCheckContext?.active);
  if (!view.signedIn) {
    const provider = view.provider;
    const relogin = miniButton(text.accountRelogin, () => {
      openSignInDialog(provider, { accountKey: view.key });
    });
    relogin.className = "mini-button primary";
    relogin.title = text.accountReloginTitle;
    actions.append(relogin);
  }
  const checkButton = miniButton(text.accountCheck, () => openAccountCheck(account));
  checkButton.disabled = busy;
  if (busy) checkButton.title = text.accountCheckBusy;
  actions.append(checkButton);
  actions.append(miniButton(text.accountDetail, () => openAccountDetail(account)));
  if (!view.signedIn) {
    actions.append(miniButton(text.accountClear, () => askClearIdentity(account), true));
  }

  row.append(name, fingerprint, lastLogin, checkCell, statusCell, actions);
  return row;
}

function renderAccounts() {
  const list = byId("accounts-list");
  const table = byId("account-table");
  const empty = byId("accounts-empty");
  const notice = byId("accounts-notice");
  const total = accountIdentities.length;
  const signedIn = accountIdentities.filter((item) => item?.signedIn === true).length;
  byId("account-count").textContent = String(total);
  byId("account-filter-all-count").textContent = String(total);
  byId("account-filter-signed-in-count").textContent = String(signedIn);
  byId("account-filter-signed-out-count").textContent = String(total - signedIn);
  for (const [id, value] of [
    ["account-filter-all", "all"],
    ["account-filter-signed-in", "signedIn"],
    ["account-filter-signed-out", "signedOut"],
  ]) {
    const chip = byId(id);
    const active = accountFilter === value;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  }
  const visible = sortAccounts(
    filterAccounts(accountIdentities, { query: accountQuery, filter: accountFilter }),
    accountSort,
  );
  byId("account-filter-count").textContent = text.accountFilterCount
    .replace("{shown}", String(visible.length))
    .replace("{total}", String(total));
  const message = accountsNotice || accountIdentitiesError;
  notice.textContent = message || "";
  notice.hidden = !message;
  notice.dataset.kind = accountIdentitiesError ? "error" : "";
  empty.hidden = total > 0;
  table.hidden = total === 0;
  list.textContent = "";
  if (total === 0) return;
  if (!visible.length) {
    const note = document.createElement("p");
    note.className = "proxy-filter-empty";
    note.textContent = text.accountNoMatch;
    list.append(note);
    return;
  }
  for (const account of visible) list.append(accountRow(account));
}

function setAccountFilter(value) {
  accountFilter = value;
  renderAccounts();
}

async function refreshAccounts() {
  await loadAccountIdentities();
  if (!accountIdentitiesError) {
    accountsNotice = text.accountsRefreshed
      .replace("{count}", String(accountIdentities.length));
    renderAccounts();
    toast(text.toastRefreshed);
  }
}

function toast(message) {
  const wrap = byId("toasts");
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  wrap.append(node);
  setTimeout(() => node.remove(), 2800);
}

// --- account detail dialog ------------------------------------------------

function setDetailError(message) {
  const node = byId("account-detail-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setDetailStatus(message) {
  const node = byId("account-detail-note-status");
  node.textContent = message || "";
  node.hidden = !message;
}

function renderDetailFacts(view) {
  const facts = byId("account-detail-facts");
  facts.textContent = "";
  for (const [label, value] of [
    [text.accountDetailProvider, view.providerLabel],
    [text.accountDetailKey, view.key],
    [text.accountDetailFingerprint, view.fingerprint.id || text.accountFingerprintNone],
    [text.accountDetailPinnedAt, formatTime(view.fingerprint.pinnedAt)],
    [text.accountDetailLastLoginExit, formatExit(view.lastLogin, text.accountExitDirect)],
    [text.accountDetailStatus, view.signedIn ? text.accountSignedIn : text.accountSignedOut],
  ]) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrap.append(dt, dd);
    facts.append(wrap);
  }
}

function renderDetailHistory(checks) {
  const list = byId("account-detail-history");
  list.textContent = "";
  if (!checks.length) {
    const none = document.createElement("p");
    none.className = "identity-empty";
    none.textContent = text.accountDetailHistoryEmpty;
    list.append(none);
    return;
  }
  for (const check of checks) {
    const row = document.createElement("div");
    row.className = "identity-row";
    const grade = document.createElement("span");
    grade.className = `proxy-score ${gradeTone(check?.grade)}`;
    grade.textContent = String(check?.grade || "—");
    const meta = document.createElement("span");
    meta.className = "identity-meta";
    meta.textContent = text.accountDetailHistoryLine
      .replace("{grade}", String(check?.grade || "—"))
      .replace("{time}", formatTime(check?.at))
      .replace("{exit}", formatExit(check, text.accountExitDirect))
      .replace("{exposure}", String(check?.exposure ?? 0));
    row.append(grade, meta);
    list.append(row);
  }
}

function openAccountDetail(account) {
  const dialog = byId("account-detail-dialog");
  const view = accountDisplay(account);
  accountDetailContext = { provider: view.provider, key: view.key, account };
  byId("account-detail-title").textContent = view.name;
  byId("account-detail-copy").textContent = `${view.providerLabel} · ${view.key}`;
  renderDetailFacts(view);
  byId("account-detail-note").value = view.note;
  setDetailError("");
  setDetailStatus(view.signedIn ? text.accountDetailSigninHint : text.accountDetailRetiredHint);
  renderDetailHistory(view.checks);
  if (!dialog.open) dialog.showModal();
}

function closeAccountDetail() {
  const dialog = byId("account-detail-dialog");
  if (dialog.open) dialog.close();
}

function cleanupAccountDetail() {
  accountDetailContext = null;
  setDetailError("");
}

async function saveAccountNote() {
  const context = accountDetailContext;
  if (!context || noteSaving) return;
  const note = byId("account-detail-note").value;
  if (note.length > NOTE_MAX_LENGTH) {
    setDetailError(text.accountDetailNoteTooLong);
    return;
  }
  noteSaving = true;
  byId("account-detail-note-save").disabled = true;
  byId("account-detail-note-save").textContent = text.accountDetailNoteSaving;
  setDetailError("");
  try {
    const data = await api(accountIdentityPath(context.provider, context.key), {
      method: "PATCH",
      body: { note },
    });
    if (accountDetailContext !== context) return;
    // Only the row the service returned is applied; never a locally invented
    // account object. The PATCH response is the source of truth for the note.
    if (data?.account) {
      const index = accountIdentities.findIndex(
        (item) => item?.provider === context.provider && item?.key === context.key,
      );
      if (index >= 0) accountIdentities[index] = data.account;
      context.account = data.account;
      renderDetailFacts(accountDisplay(data.account));
      renderDetailHistory(accountView(data.account).checks);
    }
    setDetailStatus(text.accountDetailSaved);
    toast(text.toastNoteSaved);
    renderAccounts();
  } catch (error) {
    if (accountDetailContext === context) setDetailError(serverErrorText(error));
  } finally {
    noteSaving = false;
    byId("account-detail-note-save").disabled = false;
    byId("account-detail-note-save").textContent = text.accountDetailNoteSave;
  }
}

function openCheckFromDetail() {
  const context = accountDetailContext;
  if (!context) return;
  const account = accountIdentities.find(
    (item) => item?.provider === context.provider && item?.key === context.key,
  ) || context.account;
  byId("account-detail-dialog").close();
  openAccountCheck(account);
}

// --- account check dialog -------------------------------------------------

const checkErrorKeys = {
  browser_missing: "checkErrorBrowserMissing",
  executable_missing: "checkErrorExecutableMissing",
  identity_missing: "checkErrorIdentityMissing",
  launch_failed: "checkErrorLaunchFailed",
  launch_timeout: "checkErrorLaunchTimeout",
  page_timeout: "checkErrorPageTimeout",
  verdict_missing: "checkErrorVerdictMissing",
  cancelled: "checkErrorCancelled",
  proxy_not_found: "checkErrorProxyNotFound",
  account_not_found: "checkErrorAccountNotFound",
  check_busy: "checkErrorCheckBusy",
  internal: "checkErrorInternal",
};

function checkReason(job) {
  const key = checkErrorKeys[String(job?.errorCode || "")];
  if (key && text[key]) return text[key];
  if (job?.error) return String(job.error);
  return text.checkErrorUnknown;
}

function setCheckError(message) {
  const node = byId("account-check-error");
  node.textContent = message || "";
  node.hidden = !message;
}

function setCheckView(view) {
  byId("account-check-setup").hidden = view !== "setup";
  byId("account-check-running").hidden = view !== "running";
  byId("account-check-result").hidden = view !== "result";
  byId("account-check-failed").hidden = view !== "failed";
  byId("account-check-dismiss").hidden = view === "running";
  byId("account-check-start").hidden = view !== "setup";
  byId("account-check-again").hidden = view !== "result";
  byId("account-check-details").hidden = view !== "result";
  byId("account-check-reexit").hidden = view !== "result";
  byId("account-check-cancel").hidden = view !== "running";
  byId("account-check-retry").hidden = view !== "failed";
  byId("account-check-change-exit").hidden = view !== "failed";
}

function stopCheckPolling() {
  if (accountCheckTimer) {
    clearTimeout(accountCheckTimer);
    accountCheckTimer = null;
  }
}

function startCheckPolling() {
  stopCheckPolling();
  accountCheckTimer = setTimeout(pollAccountCheck, ACCOUNT_CHECK_POLL_MS);
}

function stopCheckTicker() {
  if (accountCheckTicker) {
    clearInterval(accountCheckTicker);
    accountCheckTicker = null;
  }
}

function renderCheckElapsed() {
  const context = accountCheckContext;
  if (!context) return;
  const elapsed = Math.max(0, Date.now() - context.startedAt);
  const ratio = Math.min(0.94, elapsed / ACCOUNT_CHECK_VISUAL_MS);
  byId("account-check-progress-bar").style.width = `${Math.round(ratio * 100)}%`;
  byId("account-check-progress-text").textContent = text.accountCheckElapsed
    .replace("{seconds}", String(Math.floor(elapsed / 1000)));
  const state = context.job?.state || "launching";
  byId("account-check-running-state").textContent =
    state === "checking" ? text.accountCheckRunningReading : text.accountCheckRunningOpening;
}

function startCheckTicker() {
  stopCheckTicker();
  accountCheckTicker = setInterval(renderCheckElapsed, 250);
}

function renderCheckProxies(selectedId = "") {
  const select = byId("account-check-proxy");
  const previous = selectedId || select.value;
  select.textContent = "";
  const direct = document.createElement("option");
  direct.value = "";
  direct.textContent = text.accountCheckProxyDirect;
  select.append(direct);
  for (const proxy of checkProxies) {
    const option = document.createElement("option");
    option.value = proxy.id;
    option.textContent = `${proxy.name || proxy.id} · ${formatAddress(proxy)}`;
    select.append(option);
  }
  select.value = checkProxies.some((proxy) => proxy.id === previous) ? previous : "";
}

async function refreshCheckProxies(selectedId = "") {
  try {
    const data = await api("api/proxies");
    if (Array.isArray(data?.proxies)) checkProxies = data.proxies;
  } catch {
    // Keep the bootstrap list if the read failed; the dialog still works.
  }
  renderCheckProxies(selectedId);
}

function openAccountCheck(account) {
  if (accountCheckContext?.active) {
    toast(text.accountCheckBusy);
    return;
  }
  const dialog = byId("account-check-dialog");
  const view = accountDisplay(account);
  accountCheckContext = {
    provider: view.provider,
    key: view.key,
    account,
    active: false,
    lastCheck: view.lastCheck,
    startedAt: 0,
    job: null,
  };
  byId("account-check-copy").textContent = text.accountCheckCopy;
  byId("account-check-identity").textContent =
    `${view.fingerprint.id || text.accountFingerprintNone} · ${view.providerLabel}`;
  setCheckError("");
  setCheckView("setup");
  renderCheckProxies(view.lastCheck?.proxyId || "");
  if (!dialog.open) dialog.showModal();
  refreshCheckProxies(view.lastCheck?.proxyId || "");
  renderAccounts();
}

async function startAccountCheck() {
  const context = accountCheckContext;
  if (!context || context.active) return;
  const selected = byId("account-check-proxy").value;
  const proxyId = selected || null;
  context.active = true;
  context.startedAt = Date.now();
  context.job = { state: "launching", proxyId };
  setCheckError("");
  setCheckView("running");
  renderCheckElapsed();
  startCheckTicker();
  renderAccounts();
  try {
    const data = await api(accountCheckPath(context.provider, context.key), {
      method: "POST",
      body: { proxyId },
    });
    if (accountCheckContext !== context) return;
    context.job = data?.job || { state: "launching", proxyId };
    startCheckPolling();
  } catch (error) {
    if (accountCheckContext !== context) return;
    context.active = false;
    stopCheckTicker();
    setCheckError(serverErrorText(error));
    setCheckView("setup");
    renderAccounts();
  }
}

function checkExitLabel(job, context) {
  if (job?.proxyName || job?.region) return formatExit(job, text.accountExitDirect);
  const proxy = checkProxies.find((item) => item?.id === context?.job?.proxyId);
  return proxy?.name || text.accountExitDirect;
}

function renderCheckResult(job) {
  const grade = String(job?.grade || "—");
  const node = byId("account-check-grade");
  node.className = `proxy-score account-check-grade ${gradeTone(grade)}`;
  node.textContent = grade;
  const time = formatTime(job?.finishedAt || job?.startedAt);
  byId("account-check-summary").textContent = text.accountCheckSummary
    .replace("{exit}", checkExitLabel(job, accountCheckContext))
    .replace("{time}", time);
  byId("account-check-verdict").textContent = text[`gradeMeaning${grade}`] || "";
  byId("account-check-grade-value").textContent = grade;
  byId("account-check-exit").textContent = checkExitLabel(job, accountCheckContext);
  byId("account-check-time").textContent = time;
  const lines = byId("account-check-lines");
  lines.textContent = "";
  for (const value of formatCheckSummary(job, {
    exposure: text.accountCheckExposure,
    clean: text.accountCheckNoExposure,
  })) {
    const item = document.createElement("li");
    item.dataset.tone = "note";
    item.textContent = value;
    lines.append(item);
  }
  setCheckView("result");
}

// Failure is NOT a bad verdict: no new verdict exists. The previous one is
// shown again verbatim, and the server (which writes no history on failure)
// is re-read so the table keeps that previous verdict.
function renderCheckFailed(job, previous) {
  const context = accountCheckContext;
  const exit = checkExitLabel(job, context);
  byId("account-check-failed-title").textContent = text.accountCheckFailedTitle;
  byId("account-check-failed-detail").textContent = text.accountCheckFailedDetail
    .replace("{reason}", checkReason(job))
    .replace("{exit}", exit);
  const lines = byId("account-check-failed-lines");
  lines.textContent = "";
  const head = document.createElement("li");
  head.dataset.tone = "warn";
  head.textContent = text.accountCheckFailedNoVerdict;
  lines.append(head);
  const keep = document.createElement("li");
  keep.dataset.tone = "note";
  keep.textContent = previous
    ? text.accountCheckFailedKeepPrevious
        .replace("{grade}", String(previous.grade || "—"))
        .replace("{time}", formatTime(previous.at))
        .replace("{exit}", formatExit(previous, text.accountExitDirect))
    : text.accountCheckFailedNoPrevious;
  lines.append(keep);
  const exitLine = document.createElement("li");
  exitLine.dataset.tone = "note";
  exitLine.textContent = text.accountCheckFailedExit.replace("{exit}", exit);
  lines.append(exitLine);
  setCheckView("failed");
}

async function finishAccountCheck(context, ok) {
  stopCheckPolling();
  stopCheckTicker();
  context.active = false;
  if (ok) renderCheckResult(context.job);
  else renderCheckFailed(context.job, context.lastCheck);
  // Re-read the list: on success it carries the new history, on failure it
  // still carries the previous verdict because the service wrote nothing.
  await loadAccountIdentities();
  renderAccounts();
  if (ok) toast(text.toastCheckDone.replace("{grade}", String(context.job?.grade || "—")));
}

async function pollAccountCheck() {
  accountCheckTimer = null;
  const context = accountCheckContext;
  if (!context || !context.active || !byId("account-check-dialog").open) return;
  try {
    const data = await api(accountCheckPath(context.provider, context.key));
    if (accountCheckContext !== context) return;
    if (data?.job) context.job = data.job;
  } catch (error) {
    if (accountCheckContext !== context) return;
    setCheckError(serverErrorText(error));
    startCheckPolling();
    return;
  }
  renderCheckElapsed();
  const state = context.job?.state || "";
  if (state === "done") {
    await finishAccountCheck(context, true);
    return;
  }
  if (state === "error" || state === "cancelled") {
    await finishAccountCheck(context, false);
    return;
  }
  startCheckPolling();
}

async function cancelAccountCheck() {
  const context = accountCheckContext;
  if (!context) return;
  try {
    const data = await api(`${accountCheckPath(context.provider, context.key)}/cancel`, {
      method: "POST",
    });
    if (accountCheckContext !== context) return;
    if (data?.job) context.job = data.job;
  } catch (error) {
    if (accountCheckContext === context) setCheckError(serverErrorText(error));
    return;
  }
  stopCheckPolling();
  stopCheckTicker();
  context.active = false;
  byId("account-check-dialog").close();
  toast(text.toastCheckCancelled);
  await loadAccountIdentities();
  renderAccounts();
}

function showCheckSetup() {
  stopCheckPolling();
  stopCheckTicker();
  if (accountCheckContext) accountCheckContext.active = false;
  setCheckError("");
  setCheckView("setup");
  byId("account-check-proxy").focus();
  renderAccounts();
}

function openDetailsFromCheck() {
  const context = accountCheckContext;
  if (!context) return;
  const account = accountIdentities.find(
    (item) => item?.provider === context.provider && item?.key === context.key,
  ) || context.account;
  byId("account-check-dialog").close();
  openAccountDetail(account);
}

function closeAccountCheck() {
  const dialog = byId("account-check-dialog");
  if (accountCheckContext?.active) {
    cancelAccountCheck();
    return;
  }
  if (dialog.open) dialog.close();
}

function cleanupAccountCheck() {
  stopCheckPolling();
  stopCheckTicker();
  accountCheckContext = null;
  setCheckError("");
  renderAccounts();
}

applyText();
byId("tab-providers").addEventListener("click", () => selectTab("providers"));
byId("tab-proxies").addEventListener("click", () => selectTab("proxies"));
byId("retry").addEventListener("click", () => location.reload());
byId("add-proxy").addEventListener("click", () => openProxyDialog());
byId("add-proxy-empty").addEventListener("click", () => openProxyDialog());
// Save is wired to a plain click, not to form submission. magpie hosts page
// plugins in <iframe sandbox="allow-scripts"> with no allow-forms, so the
// browser blocks form submission before a submit event can fire and a
// type="submit" button never reaches saveProxy(). The dialog must not depend on
// implicit submission either; keep the explicit click below as the real path.
byId("save-proxy").addEventListener("click", () => {
  saveProxy();
});
// Kept for a normal (non-sandboxed) browser, where pressing Enter in the form
// still submits. The button is type="button" now, so clicking it does not
// double-trigger this path, and saveProxy() guards re-entry via context.saving.
byId("proxy-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveProxy();
});
byId("test-proxy").addEventListener("click", testDialogProxy);
byId("proxy-cancel").addEventListener("click", closeProxyDialog);
byId("proxy-close").addEventListener("click", closeProxyDialog);
byId("proxy-dialog").addEventListener("close", cleanupProxyDialog);
byId("proxy-form").addEventListener("input", () => {
  if (!dialogContext) return;
  dialogContext.lastTest = null;
  if (dialogContext.testing) {
    cancelDialogTest();
    setDialogBusy(false);
  }
  clearTestResult();
});
byId("confirm-cancel").addEventListener("click", () => {
  confirmController.cancel();
  closeConfirmDialog();
});
byId("confirm-close").addEventListener("click", () => {
  confirmController.cancel();
  closeConfirmDialog();
});
byId("confirm-action").addEventListener("click", confirmDelete);
byId("confirm-dialog").addEventListener("close", cleanupConfirmDialog);
byId("confirm-dialog").addEventListener("cancel", (event) => {
  if (deleting) event.preventDefault();
});
window.addEventListener("pagehide", () => {
  for (const id of [...rowTests.keys()]) cancelRowTest(id);
  cancelDialogTest();
  stopEnvironmentPolling();
  stopSignInPolling();
  stopScorePolling();
  stopPluginScanPolling();
  stopCheckPolling();
  stopCheckTicker();
});
// The plugin-scan follow-up pauses while the page is hidden; resume it (same
// bounded budget) when the page comes back.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (pluginScanPoll && !pluginScanPoll.timer && !pluginScanPoll.inflight) schedulePluginScanPoll();
});
byId("filter-reset").addEventListener("click", resetProxyFilters);
byId("filter-latency-min").addEventListener("input", () => {
  proxyFilter.minLatency = byId("filter-latency-min").value;
  renderProxies();
});
byId("filter-latency-max").addEventListener("input", () => {
  proxyFilter.maxLatency = byId("filter-latency-max").value;
  renderProxies();
});
byId("score-cancel").addEventListener("click", cancelScore);
byId("environment-prepare").addEventListener("click", prepareEnvironment);
byId("environment-cancel").addEventListener("click", cancelEnvironment);
byId("environment-retry").addEventListener("click", prepareEnvironment);
byId("signin-start").addEventListener("click", startSignIn);
byId("signin-cancel").addEventListener("click", cancelSignIn);
byId("identities-retry").addEventListener("click", loadAccountIdentities);
byId("signin-close").addEventListener("click", closeSignInDialog);
byId("signin-close-footer").addEventListener("click", closeSignInDialog);
byId("report-close").addEventListener("click", closeReportDialog);
byId("report-cancel").addEventListener("click", closeReportDialog);
byId("report-copy-body").addEventListener("click", copyReportBody);
byId("report-open").addEventListener("click", openReportOnGitHub);
byId("report-note").addEventListener("input", scheduleReport);
byId("signin-dialog").addEventListener("close", cleanupSignInDialog);
// Escape closes the dialog natively; intercept so a running flow is cancelled
// first instead of being left invisible in the background.
byId("signin-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeSignInDialog();
});
// --- accounts tab / panel wiring ---
byId("tab-accounts").addEventListener("click", () => {
  selectTab("accounts");
  loadAccountIdentities();
});
byId("accounts-refresh").addEventListener("click", refreshAccounts);
byId("account-search").addEventListener("input", () => {
  accountQuery = byId("account-search").value;
  renderAccounts();
});
byId("account-sort").addEventListener("change", () => {
  accountSort = byId("account-sort").value;
  renderAccounts();
});
byId("account-filter-all").addEventListener("click", () => setAccountFilter("all"));
byId("account-filter-signed-in").addEventListener("click", () => setAccountFilter("signedIn"));
byId("account-filter-signed-out").addEventListener("click", () => setAccountFilter("signedOut"));
byId("account-detail-close").addEventListener("click", closeAccountDetail);
byId("account-detail-dismiss").addEventListener("click", closeAccountDetail);
byId("account-detail-check").addEventListener("click", openCheckFromDetail);
byId("account-detail-note-save").addEventListener("click", saveAccountNote);
byId("account-detail-dialog").addEventListener("close", cleanupAccountDetail);
byId("account-check-close").addEventListener("click", closeAccountCheck);
byId("account-check-dismiss").addEventListener("click", closeAccountCheck);
byId("account-check-start").addEventListener("click", startAccountCheck);
byId("account-check-again").addEventListener("click", startAccountCheck);
byId("account-check-retry").addEventListener("click", startAccountCheck);
byId("account-check-reexit").addEventListener("click", showCheckSetup);
byId("account-check-change-exit").addEventListener("click", showCheckSetup);
byId("account-check-cancel").addEventListener("click", cancelAccountCheck);
byId("account-check-details").addEventListener("click", openDetailsFromCheck);
byId("account-check-dialog").addEventListener("close", cleanupAccountCheck);
byId("account-check-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeAccountCheck();
});

load();
