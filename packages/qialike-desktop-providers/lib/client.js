/**
 * The providers settings page — the browser half of `@qialike/qialike-desktop-providers`.
 *
 * HAND-WRITTEN, NOT BUILT. The harness's own client bundles come out of
 * `packages/client/tsdown.client.ts`, a preset that imports a dozen files from
 * inside the harness monorepo (platform module tables, CSS-module virtual loaders,
 * build-environment defines) and is not published. The artifact it produces is a
 * small, documented contract instead:
 *
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory(require) -> module.exports   // exports.apply, exports.inject
 *
 * Executing the script only *registers* the factory; the body runs on first
 * materialization, and `require` resolves against the loader's module table — so
 * `react` and `@deepseek-ai/cordis` arrive without an import map or a bundler.
 * This file is therefore plain ES5-era JavaScript with `React.createElement` and
 * no JSX, and needs no toolchain at all. The same reasoning as `preload.cjs` in
 * the Electron shell: when the build machinery is private to another repository
 * and the artifact contract is this small, hand-writing beats vendoring.
 *
 * WHY IT TALKS TO AN HTTP ROUTE. The page edits `qialike.json` on the Host. The
 * harness's supported cross-boundary call is a Typert Remote, whose artifacts are
 * generated on both sides by that same private toolchain; a `connection.fetch`
 * route is the other supported path and needs no generation. The shell proxies
 * `/api/*` to the Host with the session cookie attached, so a same-origin `fetch`
 * is authenticated exactly like the harness's own `/api/file`.
 *
 * @module @qialike/qialike-desktop-providers/client
 */

window.__ModuleLoader__.load({
  id: '@qialike/qialike-desktop-providers',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /**
     * The Host route that reads and writes `qialike.json`.
     *
     * DOCUMENT-RELATIVE, with no leading slash, and that is not a style choice:
     * the served document carries `<base href="./">`, and the harness spells every
     * browser-side app route this way (`PRESENT_HOST_ROUTE = PRESENT_HOST_PATH
     * .slice(1)` in `ui-deliverables/src/presented.ts`). A root-absolute literal
     * resolves against the origin instead of the document, which breaks the moment
     * the surface is mounted under a prefix — and a repository script gates the
     * in-tree form of exactly this.
     */
    const API = 'api/qialike/providers'

    /** This plugin's dictionary namespace. */
    const NS = 'qialike-providers'

    const en = {
      'nav': 'Providers',
      'intro': 'Provider profiles are stored in qialike.json, the file the qialike CLI reads. Changes here are shared with the terminal client.',
      'loading': 'Loading providers…',
      'reload': 'Reload',
      'search': 'Search',
      'searchHint': 'Filter by name, route or endpoint',
      'searchEmpty': 'No provider matches that search.',
      'clear': 'Clear',
      'addProviderFromCatalogue': 'Add provider',
      'addCustomProvider': 'Add a custom provider',
      'catalogueTitle': 'Choose a provider to configure',
      'catalogueHint': 'Providers already configured are shown with their key set. Pick one to replace its key or endpoint.',
      'choose': 'Choose',
      'back': 'Back',
      'activatedEmpty': 'No provider is configured yet. Add one to start a session.',
      'keySetTag': 'key set',
      'apiKey': 'API key',
      'apiKeyHint': 'Stored in the credential store. Leave empty to keep the current key.',
      'apiKeyPlaceholder': 'sk-…',
      'keyMissingTag': 'no key',
      'editProvider': 'Edit',
      'remove': 'Remove',
      'reset': 'Reset to shipped',
      'cancel': 'Cancel',
      'save': 'Save',
      'saving': 'Saving…',
      'enable': 'Enable',
      'disable': 'Disable',
      'enabled': 'Enabled',
      'disabled': 'Disabled',
      'builtin': 'built-in',
      'configured': 'configured',
      'template': 'no profile',
      'unlisted': 'from a plugin',
      'keySet': 'API key set',
      'keyMissing': 'No API key',
      'models': 'models',
      'route': 'Route id',
      'routeHint': 'Lowercase id, e.g. my-gateway. It keys the profile and the API-key name.',
      'displayName': 'Display name',
      'baseURL': 'Endpoint',
      'api': 'Wire protocol',
      'apiKeyEnv': 'API key reference',
      'apiKeyEnvHint': 'Credential name, e.g. OPENROUTER_API_KEY. Stored by the CLI, not here.',
      'discover': 'Discover models',
      'discovering': 'Probing…',
      'discovered': (n, kept, filtered) => filtered > 0
        ? `Found ${n} models; ${filtered} hidden by this route's prefix rules, ${kept} kept.`
        : `Found ${n} models.`,
      'discoverFailed': 'The endpoint served no /models list.',
      'modelIds': 'Models',
      'modelIdsHint': 'One id per line. Leave empty to use the endpoint catalog.',
      'remountOk': 'Saved to qialike.json and reloaded.',
      'remountNo': 'Saved to qialike.json. Restart the app to apply.',
      'empty': 'No providers.',
      'configAt': 'Configuration file',
      'welcomeTitle': 'Welcome to qialike',
      'welcomeIntro': 'Connect a model provider to start. Your key is stored by the host, in the same credential file the qialike CLI uses.',
      'welcomeProvider': 'Provider',
      'welcomeKey': 'API key',
      'welcomeKeyHint': 'Paste the key for the selected provider. It is never shown again.',
      'welcomeModel': 'Model',
      'welcomeModelHint': 'The default model new sessions start with. You can change it later.',
      'welcomeModelUnknown': 'Press “Find models” to load this provider’s catalogue.',
      'welcomeFind': 'Find models',
      'welcomeStart': 'Start',
      'welcomeSkip': 'Skip for now',
      'welcomeNeedsKey': 'Enter a key to continue.',
      'welcomeNeedsModel': 'Choose a model to continue.',
      'groupOff': (group) => `Group "${group}" is off in qialike.json`,
      'groupOffHint': 'That switch covers the whole group; change it in the file to bring these back.',
    }

    const zh = {
      'nav': '模型服务',
      'intro': 'provider 配置存放于 qialike.json，也就是 qialike CLI 读取的同一个文件。此处的改动与终端客户端共享。',
      'loading': '正在加载…',
      'reload': '重新加载',
      'search': '搜索',
      'searchHint': '按名称、路由或端点过滤',
      'searchEmpty': '没有匹配的 provider。',
      'clear': '清除',
      'addProviderFromCatalogue': '添加 provider',
      'addCustomProvider': '添加自定义 provider',
      'catalogueTitle': '选择要配置的 provider',
      'catalogueHint': '已配置过的 provider 会标出已设置密钥。选一个即可替换它的密钥或端点。',
      'choose': '选择',
      'back': '返回',
      'activatedEmpty': '还没有配置任何 provider。添加一个后即可开始会话。',
      'keySetTag': '已设置密钥',
      'apiKey': 'API 密钥',
      'apiKeyHint': '保存在凭据存储中。留空表示不改变现有密钥。',
      'apiKeyPlaceholder': 'sk-…',
      'keyMissingTag': '无密钥',
      'editProvider': '编辑',
      'remove': '删除',
      'reset': '恢复出厂',
      'cancel': '取消',
      'save': '保存',
      'saving': '保存中…',
      'enable': '启用',
      'disable': '停用',
      'enabled': '已启用',
      'disabled': '已停用',
      'builtin': '内置',
      'configured': '已配置',
      'template': '无配置档',
      'unlisted': '来自插件',
      'keySet': '密钥已配置',
      'keyMissing': '未配置密钥',
      'models': '个模型',
      'route': '路由 id',
      'routeHint': '小写 id，例如 my-gateway。它同时决定 profile 的键与密钥名。',
      'displayName': '显示名',
      'baseURL': '接口地址',
      'api': '协议',
      'apiKeyEnv': '密钥引用',
      'apiKeyEnvHint': '凭据名，例如 OPENROUTER_API_KEY。密钥由 CLI 存储，不在此处。',
      'discover': '探测模型',
      'discovering': '探测中…',
      'discovered': (n, kept, filtered) => filtered > 0
        ? `发现 ${n} 个模型；其中 ${filtered} 个被该路由的前缀规则隐藏，保留 ${kept} 个。`
        : `发现 ${n} 个模型。`,
      'discoverFailed': '该地址没有提供 /models 列表。',
      'modelIds': '模型列表',
      'modelIdsHint': '每行一个 id。留空则使用接口返回的目录。',
      'remountOk': '已写入 qialike.json 并重新加载。',
      'remountNo': '已写入 qialike.json。重启应用后生效。',
      'empty': '没有 provider。',
      'configAt': '配置文件',
      'welcomeTitle': '欢迎使用 qialike',
      'welcomeIntro': '连接一个模型服务即可开始。密钥由宿主保存，与 qialike CLI 使用同一份凭据文件。',
      'welcomeProvider': '服务商',
      'welcomeKey': 'API 密钥',
      'welcomeKeyHint': '粘贴所选服务商的密钥。保存后不再显示。',
      'welcomeModel': '模型',
      'welcomeModelHint': '新会话默认使用的模型，之后可随时更改。',
      'welcomeModelUnknown': '点击“获取模型”加载该服务商的模型目录。',
      'welcomeFind': '获取模型',
      'welcomeStart': '开始',
      'welcomeSkip': '暂时跳过',
      'welcomeNeedsKey': '请输入密钥。',
      'welcomeNeedsModel': '请选择一个模型。',
      'groupOff': (group) => `分组 "${group}" 在 qialike.json 中已关闭`,
      'groupOffHint': '该开关覆盖整组；要在文件中修改才能恢复。',
    }

    /** The wire protocols the CLI's schema accepts, in its own order. */
    const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative']

    // ── styles ────────────────────────────────────────────────────────────────
    //
    // Inline, using the theme's alias tokens rather than literal colours: the
    // client notes require the variables so a contribution stays legible in the
    // other colour scheme, and a hand-written bundle has no CSS pipeline to put
    // a stylesheet through.
    //
    // TWO NAMES HERE USED TO BE WRONG, and the way they were wrong is worth stating
    // because nothing could see it. `--dsw-alias-border-secondary` and
    // `--dsw-alias-bg-accent` do not exist in the harness's vocabulary — they read
    // as plausible members of the `--dsw-alias-border-*` and `--dsw-alias-bg-*`
    // families, which is exactly why they survived review. Each carried a hardcoded
    // hex fallback, so the settings page was pinned to `#333` borders and a
    // `#1f6feb` primary button in **all sixteen themes** while looking themed.
    // `tests/client-tokens.test.mjs` now cross-checks every token named in these
    // bundles against the harness's own sources, and would have failed on both.
    //
    // THE FALLBACKS ARE GONE ENTIRELY, not just corrected. A `var(--token, #hex)`
    // fallback is dead code while the token exists and a silent one-colour pin the
    // moment it does not — the second of which is the failure above. With the token
    // names verified by that test, `var(--token)` is both correct and honest.
    //
    // `--dsw-alias-border-l2` is the ordinary border of the four-step ladder
    // (`l1` quietest through `l4` strongest), which is what these row, form and
    // input outlines are. `--dsw-alias-button-primary-fill` is the design system's
    // own fill for exactly this button, and `--dsw-alias-label-primary-foreground`
    // is its label colour — the pair the palette provides rather than a chosen pair
    // of literals.

    const muted = { color: 'var(--dsw-alias-label-secondary)' }
    const styles = {
      section: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '4px 0', fontSize: '13px' },
      intro: { ...muted, lineHeight: '1.5', margin: 0 },
      bar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      list: { display: 'flex', flexDirection: 'column', gap: '6px' },
      // The search row: the field takes the width, the count sits at the end. Kept on its
      // own line rather than inside `bar` so Add/Reload stay where they have always been.
      searchBar: { display: 'flex', gap: '8px', alignItems: 'center' },
      searchInput: {
        font: 'inherit', flex: 1, padding: '5px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      addRow: {
        font: 'inherit', cursor: 'pointer', textAlign: 'left', padding: '8px 10px',
        borderRadius: '6px', border: '1px dashed var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      row: {
        display: 'flex', gap: '10px', alignItems: 'center', padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1)',
      },
      name: { fontWeight: 600 },
      grow: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      meta: { ...muted, fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: {
        ...muted, fontSize: '11px', padding: '1px 6px', borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      dot: (ok) => ({
        width: '7px', height: '7px', borderRadius: '999px', flex: 'none',
        background: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
      }),
      button: {
        font: 'inherit', cursor: 'pointer', padding: '4px 10px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent', color: 'var(--dsw-alias-label-primary)',
      },
      primary: {
        font: 'inherit', cursor: 'pointer', padding: '4px 10px', borderRadius: '6px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
      },
      form: {
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px',
      },
      field: { display: 'flex', flexDirection: 'column', gap: '3px' },
      label: { fontWeight: 600, fontSize: '12px' },
      hint: { ...muted, fontSize: '11px' },
      input: {
        font: 'inherit', padding: '5px 8px', borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      notice: { ...muted, fontSize: '12px' },
      path: { fontFamily: 'var(--dsw-font-mono)', fontSize: '11px' },
      overlay: {
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '24px',
        background: 'var(--dsw-alias-bg-mask-1)',
      },
      overlayCard: {
        width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '12px',
        padding: '22px', borderRadius: '14px', fontSize: '13px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l4)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, .35)',
      },
      overlayTitle: { margin: 0, fontSize: '18px', fontWeight: 600 },
    }

    /** One labelled field. */
    function field(label, hint, control) {
      return h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        control,
        hint === undefined ? null : h('span', { style: styles.hint }, hint))
    }

    /**
     * The settings page.
     *
     * Two modes rather than an inline editor per row: a provider profile has
     * seven fields and one of them is a model list, which does not fit inside a
     * row. The same shape the CLI's `/models` dialog uses.
     */
    function ProvidersSection(props) {
      const t = props.t
      const [state, setState] = React.useState({ status: 'loading' })
      /**
       * What the search box holds.
       *
       * WHY THIS EXISTS. The page lists 62 rows — the builtin plus every template and
       * gateway group — and finding one by eye means scanning a wall of `route · api ·
       * baseURL`. The CLI's own provider picker has a search field for the same list; this
       * is that, filtered the same way a person would filter it: against the display name,
       * the route id and the endpoint, because all three are what someone remembers.
       */
      const [query, setQuery] = React.useState('')
      /**
       * Which screen the page is on: the list of what is configured, or the catalogue to add from.
       *
       * WHY THIS IS A MODE AND NOT A LONGER LIST. The page used to print all 63 routes, so
       * "which providers do I have?" — the question someone opens this page with — took
       * reading a wall of mostly-empty rows. It now shows only what is usable: a route whose
       * credential is set, plus this product's own gateway, which is offered before it is
       * configured so its key can be entered. Everything else is one step away under
       * "Add provider", which is where the full catalogue lives with its key status.
       */
      const [catalogue, setCatalogue] = React.useState(false)
      const [draft, setDraft] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        setState({ status: 'loading' })
        fetch(API, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => { setState({ status: 'ready', data }) })
          .catch((error) => { setState({ status: 'error', message: String(error) }) })
      }, [])

      React.useEffect(() => { load() }, [load])

      /**
       * The rows the list shows: everything when the box is empty, otherwise the subset
       * matching the display name, the route id or the endpoint.
       *
       * Derived on every render rather than stored, because the list is replaced wholesale
       * after every mutation — a stored copy would go stale the moment a provider is added
       * or a key is saved.
       */
      /**
       * Whether a route belongs to the product's own gateway.
       *
       * BOTH DEPLOYMENTS, one predicate. Bee ships as `.com` and mainland rows behind a single
       * `bee.enabled` switch, and CLI 0.11.4 renamed both — so a page that matched one name by
       * hand would leave the other on screen while the switch read "off". The list comes from
       * the Host, which reads it from the CLI's own constant.
       *
       * @param route - a row's route id.
       * @returns whether it is one of Bee's.
       */
      const isBeeRoute = (route) => {
        const bee = state.status === 'ready' ? state.data.beeRoutes : undefined
        return Array.isArray(bee) && bee.includes(route)
      }

      const matchedRoutes = React.useMemo(() => {
        const all = state.status === 'ready' && Array.isArray(state.data.routes) ? state.data.routes : []
        // THE SWITCHED-OFF GATEWAY IS NOT OFFERED HERE EITHER. Hiding it from the list and
        // leaving it selectable in the catalogue would make "hidden by default" half true, and
        // a profile saved under that route would shadow the shipped endpoint while the CLI —
        // which refuses exactly this — kept treating the route as its own.
        const routes = all.filter((row) => !(isBeeRoute(row.route) && row.enabled !== true))
        const needle = query.trim().toLowerCase()
        if (needle.length === 0) return routes
        return routes.filter((row) => {
          const haystack = `${row.displayName} ${row.route} ${row.baseURL}`.toLowerCase()
          return haystack.includes(needle)
        })
      }, [state, query])

      /**
       * The rows the main list shows: what this profile can actually send a request with.
       *
       * TWO KINDS SURVIVE. A route with a credential, because it is in use; and the product's
       * own gateway while it is switched on, because its key is entered from here and a row
       * that vanished until a key existed would be unconfigurable. The gateway ships switched
       * off — it is offered as a beta — so `enabled` is part of the rule and not an afterthought.
       *
       * The ordering is the Host's: enabled first, then by display name.
       */
      const activatedRoutes = React.useMemo(() => {
        const routes = state.status === 'ready' && Array.isArray(state.data.routes) ? state.data.routes : []
        return routes.filter((row) => {
          // THE GATEWAY IS DECIDED BY ITS SWITCH ALONE. It is a beta that ships off, and while
          // it is off the CLI does not offer it at all — measured: enabling a key under it does
          // not put it back, because the route is withdrawn from the registry rather than merely
          // filtered. Falling through to the credential test below would show a route the model
          // layer is not serving, and a "已配置" row that no request can reach.
          if (isBeeRoute(row.route)) return row.enabled === true
          return row.keyConfigured === true
        })
      }, [state])

      /** Send one mutation, then refresh and report what the Host said. */
      const post = React.useCallback(async (body) => {
        setBusy(true)
        setNotice(undefined)
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const result = await response.json()
          if (result.ok !== true) {
            setNotice({ kind: 'error', text: result.message ?? 'the Host refused the change' })
            return result
          }
          // The remount flag is what tells the user whether the running profile
          // picked the change up; the write itself already landed either way.
          setNotice({
            kind: 'info',
            text: body.op === 'discover'
              ? t('discovered')(result.discovered, result.models.length, result.filtered)
              : (result.remounted === true ? t('remountOk') : t('remountNo')),
          })
          if (body.op !== 'discover') load()
          return result
        } catch (error) {
          setNotice({ kind: 'error', text: String(error) })
          return { ok: false }
        } finally {
          setBusy(false)
        }
      }, [load, t])

      /** Open the editor for one route, or a blank draft when none is given. */
      const edit = React.useCallback((row) => {
        setNotice(undefined)
        setDraft(row === undefined
          ? { route: '', displayName: '', baseURL: '', api: APIS[0], apiKeyEnv: '', models: '', key: '' }
          : {
            route: row.route,
            displayName: row.displayName,
            baseURL: row.baseURL,
            api: row.api,
            apiKeyEnv: row.apiKeyEnv ?? '',
            models: '',
            key: '',
            source: row.source,
          })
      }, [])

      /**
       * Open the form for a route taken from the catalogue, prefilled from its template.
       *
       * Prefilled rather than blank because a catalogue entry's endpoint and wire protocol are
       * facts, not questions: asking a person to retype `https://api.openai.com/v1` invites the
       * one-character mistake that presents as a network failure. The route itself is locked —
       * it came from the catalogue, so retyping it could only break the association with the
       * template the values came from.
       */
      const chooseFrom = React.useCallback((row) => {
        const templates = state.status === 'ready' && Array.isArray(state.data.templates) ? state.data.templates : []
        const template = templates.find((item) => item.route === row.route)
        setNotice(undefined)
        setCatalogue(false)
        setQuery('')
        setDraft({
          route: row.route,
          displayName: template?.name ?? row.displayName,
          baseURL: template?.baseURL ?? row.baseURL,
          api: template?.api ?? row.api,
          apiKeyEnv: template?.apiKeyEnv ?? '',
          models: (template?.models ?? []).map((model) => model.id).join('\n'),
          key: '',
          source: 'template',
        })
      }, [state])

      /**
       * One provider row. The action differs by mode: choose it for configuration, or manage
       * what is already configured.
       *
       * The product's own gateway gets no enable/disable switch even when it is listed: its
       * switch is `bee.enabled` in `qialike.json`, which the CLI also reads, and a control here
       * that wrote a different key would be a switch that does nothing.
       */
      const rowView = (row) => {
        const isBee = isBeeRoute(row.route)
        return h('div', { key: row.route, style: styles.row },
          h('span', { style: styles.dot(row.keyConfigured), title: row.keyConfigured ? t('keySet') : t('keyMissing') }),
          h('span', { style: styles.grow },
            h('span', { style: styles.name }, row.displayName),
            h('span', { style: styles.meta },
              row.route, ' · ', row.api, ' · ', `${row.modelCount} ${t('models')}`,
              row.baseURL.length > 0 ? ` · ${row.baseURL}` : '')),
          // WHERE THE PROFILE COMES FROM, in both lists. It used to read "未配置" for a route
          // whose key arrives from the environment — true of the file, and the opposite of what
          // a list of usable providers means — so the wording now says where it comes from
          // without implying it cannot be used.
          h('span', { style: styles.tag }, t(row.source)),
          catalogue
            ? h('span', { style: styles.tag }, row.keyConfigured ? t('keySetTag') : t('keyMissingTag'))
            : null,
          catalogue || isBee ? null : h('span', { style: styles.tag }, row.enabled ? t('enabled') : t('disabled')),
          catalogue
            ? null
            : (row.groupDisabled
              ? h('span', { style: styles.tag, title: t('groupOffHint') }, t('groupOff')(row.group))
              : null),
          catalogue
            ? h('button', { style: styles.button, onClick: () => { chooseFrom(row) } }, t('choose'))
            : h('button', { style: styles.button, onClick: () => { edit(row) } }, t('editProvider')),
          catalogue || !(row.source === 'builtin' || row.source === 'configured')
            ? null
            : h('button', {
              style: styles.button,
              disabled: busy,
              onClick: async () => {
                await post(row.source === 'builtin'
                  ? { op: 'reset', route: row.route }
                  : { op: 'remove', route: row.route })
              },
            }, row.source === 'builtin' ? t('reset') : t('remove')),
          catalogue || isBee || row.source === 'builtin'
            ? null
            : h('button', {
              style: styles.button,
              // A group switch outranks this one, so an "enable" here would be a control that
              // cannot do what it says. The group's tag explains why.
              disabled: busy || (!row.enabled && row.groupDisabled),
              title: !row.enabled && row.groupDisabled ? t('groupOffHint') : undefined,
              onClick: async () => { await post({ op: 'setEnabled', route: row.route, enabled: !row.enabled }) },
            }, row.enabled ? t('disable') : t('enable')))
      }

      if (state.status === 'loading') {
        return h('div', { style: styles.section }, h('p', { style: styles.intro }, t('loading')))
      }
      if (state.status === 'error') {
        return h('div', { style: styles.section },
          h('p', { style: styles.error }, state.message),
          h('div', { style: styles.bar }, h('button', { style: styles.button, onClick: load }, t('reload'))))
      }

      const data = state.data
      const save = async () => {
        const result = await post({
          op: 'save',
          route: draft.route.trim(),
          profile: {
            displayName: draft.displayName,
            baseURL: draft.baseURL,
            api: draft.api,
            apiKeyEnv: draft.apiKeyEnv,
            models: draft.models.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
          },
        })
        if (result.ok !== true) return
        const key = (draft.key ?? '').trim()
        // The credential is stored separately from the profile, so a failure to store it is
        // reported as its own outcome rather than hidden behind a successful save.
        if (key.length === 0) { setDraft(undefined); return }
        const keyed = await post({ op: 'setKey', route: draft.route.trim(), value: key })
        if (keyed.ok === true) setDraft(undefined)
      }

      return h('div', { style: styles.section },
        h('p', { style: styles.intro }, t('intro')),
        h('p', { style: styles.hint }, `${t('configAt')}: `, h('span', { style: styles.path }, data.configPath)),

        draft === undefined
          ? h('div', { style: styles.bar },
            h('button', { style: styles.button, onClick: load, disabled: busy }, t('reload')))
          : h('div', { style: styles.form },
            field(t('route'), t('routeHint'), h('input', {
              style: styles.input, value: draft.route, disabled: draft.source !== undefined,
              onChange: (event) => { setDraft({ ...draft, route: event.target.value }) },
            })),
            field(t('displayName'), undefined, h('input', {
              style: styles.input, value: draft.displayName,
              onChange: (event) => { setDraft({ ...draft, displayName: event.target.value }) },
            })),
            field(t('baseURL'), undefined, h('input', {
              style: styles.input, value: draft.baseURL, placeholder: 'https://gateway.example/v1',
              onChange: (event) => { setDraft({ ...draft, baseURL: event.target.value }) },
            })),
            field(t('api'), undefined, h('select', {
              style: styles.input, value: draft.api,
              onChange: (event) => { setDraft({ ...draft, api: event.target.value }) },
            }, ...APIS.map((api) => h('option', { key: api, value: api }, api)))),
            field(t('apiKeyEnv'), t('apiKeyEnvHint'), h('input', {
              style: styles.input, value: draft.apiKeyEnv, placeholder: 'MY_GATEWAY_API_KEY',
              onChange: (event) => { setDraft({ ...draft, apiKeyEnv: event.target.value }) },
            })),
            // THE CREDENTIAL ITSELF, which this page could not set outside first run before.
            // A catalogue provider without a key is a row that cannot answer, so choosing one
            // has to be able to finish the job here rather than sending the user elsewhere.
            field(t('apiKey'), t('apiKeyHint'), h('input', {
              style: styles.input, type: 'password', value: draft.key ?? '',
              autoComplete: 'off', placeholder: t('apiKeyPlaceholder'),
              onChange: (event) => { setDraft({ ...draft, key: event.target.value }) },
            })),
            field(t('modelIds'), t('modelIdsHint'), h('textarea', {
              style: { ...styles.input, minHeight: '72px', fontFamily: 'ui-monospace, monospace' },
              value: draft.models,
              onChange: (event) => { setDraft({ ...draft, models: event.target.value }) },
            })),
            h('div', { style: styles.bar },
              h('button', {
                style: styles.button,
                disabled: busy || draft.baseURL.trim().length === 0,
                onClick: async () => {
                  const result = await post({ op: 'discover', baseURL: draft.baseURL.trim(), route: draft.route.trim() })
                  if (result.ok === true) setDraft({ ...draft, models: result.models.join('\n') })
                },
              }, busy ? t('discovering') : t('discover')),
              h('button', {
                style: styles.primary,
                disabled: busy || draft.route.trim().length === 0 || draft.baseURL.trim().length === 0,
                onClick: save,
              }, busy ? t('saving') : t('save')),
              h('button', { style: styles.button, onClick: () => { setDraft(undefined); setNotice(undefined) } }, t('cancel')))),

        notice === undefined ? null : h('p', {
          style: notice.kind === 'error' ? styles.error : styles.notice,
        }, notice.text),

        // AN EXPLICIT EMPTY STATE, because the alternative is a blank rectangle. It
        // should be unreachable — the host serves the built-in route plus 62 templates —
        // and that is exactly why it needs a sentence rather than silence: an empty list
        // with no text is indistinguishable from a page that failed to load, and the
        // person looking at it has nothing to report.
        // ── the catalogue, when adding ───────────────────────────────────────
        catalogue
          ? h('div', { style: styles.bar },
            h('button', { style: styles.button, onClick: () => { setCatalogue(false); setQuery('') } }, t('back')),
            h('span', { style: styles.name }, t('catalogueTitle')))
          : null,

        catalogue ? h('p', { style: styles.hint }, t('catalogueHint')) : null,

        // THE SEARCH BOX, only in the catalogue. The configured list is short by construction;
        // the catalogue is 63 rows, and scanning it by eye is what this field is for.
        // Case-insensitive substring match against three fields, because a person hunting a
        // provider remembers one of: what it is called ("OpenCode Zen"), what the config calls
        // it (`opencode-zen`), or where it points (`api.example/v1`).
        catalogue && data.routes.length > 0
          ? h('div', { style: styles.searchBar },
            h('input', {
              style: styles.searchInput,
              type: 'search',
              value: query,
              placeholder: t('searchHint'),
              'aria-label': t('search'),
              onChange: (event) => { setQuery(event.target.value) },
            }),
            query.length === 0 ? null : h('button', {
              style: styles.button,
              onClick: () => { setQuery('') },
            }, t('clear')),
            h('span', { style: styles.meta }, String(matchedRoutes.length), ' / ', String(data.routes.length)))
          : null,

        // A LIST THAT IS EMPTY SAYS WHY, rather than rendering a blank rectangle that reads as a
        // failed load. The two reasons differ and so do the sentences: nothing is configured
        // yet, or a search matched nothing.
        data.routes.length === 0
          ? h('p', { style: styles.intro }, t('empty'))
          : (catalogue ? matchedRoutes : activatedRoutes).length === 0
            ? h('p', { style: styles.intro }, catalogue ? t('searchEmpty') : t('activatedEmpty'))
            : h('div', { style: styles.list },
              ...(catalogue ? matchedRoutes : activatedRoutes).map((row) => rowView(row))),

        // THE TWO WAYS IN, at the foot of the list where the eye ends. "Add provider" opens the
        // catalogue; "Add a custom provider" opens a blank form for an endpoint no template
        // knows. One button served both before, on a page that listed every route anyway.
        catalogue
          ? null
          : h('div', { style: styles.list },
            h('button', { style: styles.addRow, onClick: () => { setCatalogue(true); setQuery('') } },
              `+ ${t('addProviderFromCatalogue')}`),
            h('button', { style: styles.addRow, onClick: () => { edit(undefined) } },
              `+ ${t('addCustomProvider')}`)))
    }

    /**
     * The first-run overlay.
     *
     * Shown when the credential store holds no usable key for any provider — the
     * host derives that from the store rather than from a "seen it" flag, so
     * clearing every key brings it back and configuring one elsewhere keeps it
     * away.
     *
     * WHY AN OVERLAY AND NOT A SETTINGS PAGE. There is a window between the app
     * starting and a provider existing in which the conversation surface cannot
     * answer anything. A page the user has to find does not close that window; an
     * overlay does. `shell.overlay` is declared by `ui-layout`'s root entry, so it
     * is mounted for the whole life of the window.
     */
    function WelcomeOverlay(props) {
      const t = props.t
      const [state, setState] = React.useState({ status: 'loading' })
      const [step, setStep] = React.useState({ route: '', key: '', model: '', models: [], note: '' })
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let live = true
        fetch(API, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => { if (live) setState({ status: 'ready', data }) })
          .catch(() => { if (live) setState({ status: 'hidden' }) })
        return () => { live = false }
      }, [])

      const post = React.useCallback(async (body) => {
        setBusy(true)
        try {
          const response = await fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          return await response.json()
        } catch (error) {
          return { ok: false, message: String(error) }
        } finally {
          setBusy(false)
        }
      }, [])

      if (state.status !== 'ready' || state.data.firstRun !== true) return null

      // Only providers a user can actually configure: the builtin cannot be given
      // a route profile, and a group-disabled one would refuse the key anyway.
      const choices = state.data.routes.filter((row) => row.enabled && !row.groupDisabled)
      const selected = choices.find((row) => row.route === step.route)

      const findModels = async () => {
        if (selected === undefined) return
        // A provider with a static catalogue needs no probe: the template already
        // knows its models, so asking the network would only add a wait.
        const known = state.data.templates.find((template) => template.route === selected.route)
        if (known !== undefined && (known.models ?? []).length > 0) {
          setStep((s) => ({ ...s, models: known.models.map((m) => m.id), note: '' }))
          return
        }
        const result = await post({ op: 'discover', baseURL: selected.baseURL, route: selected.route })
        setStep((s) => result.ok === true
          ? { ...s, models: result.models, note: '' }
          : { ...s, models: [], note: t('discoverFailed') })
      }

      const start = async () => {
        if (step.key.trim().length === 0) { setStep((s) => ({ ...s, note: t('welcomeNeedsKey') })); return }
        const keyed = await post({ op: 'setKey', route: step.route, value: step.key })
        if (keyed.ok !== true) { setStep((s) => ({ ...s, note: keyed.message })); return }
        if (step.model.length === 0) { setStep((s) => ({ ...s, note: t('welcomeNeedsModel') })); return }
        const model = await post({ op: 'setDefaultModel', provider: step.route, model: step.model })
        if (model.ok !== true) { setStep((s) => ({ ...s, note: model.message })); return }
        // Re-read rather than assume: `firstRun` is what closes the overlay, and it
        // is the host's answer that decides.
        const response = await fetch(API, { headers: { accept: 'application/json' } })
        setState({ status: 'ready', data: await response.json() })
      }

      return h('div', { style: styles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('welcomeTitle') },
        h('div', { style: styles.overlayCard },
          h('h1', { style: styles.overlayTitle }, t('welcomeTitle')),
          h('p', { style: styles.intro }, t('welcomeIntro')),
          field(t('welcomeProvider'), undefined, h('select', {
            style: styles.input,
            value: step.route,
            onChange: (event) => { setStep({ route: event.target.value, key: '', model: '', models: [], note: '' }) },
          }, h('option', { value: '' }, '—'),
            ...choices.map((row) => h('option', { key: row.route, value: row.route }, row.displayName)))),
          field(t('welcomeKey'), t('welcomeKeyHint'), h('input', {
            style: styles.input, type: 'password', value: step.key, autoComplete: 'off', spellCheck: false,
            onChange: (event) => { setStep((s) => ({ ...s, key: event.target.value })) },
          })),
          field(t('welcomeModel'), t('welcomeModelHint'),
            step.models.length === 0
              ? h('span', { style: styles.hint }, t('welcomeModelUnknown'))
              : h('select', {
                style: styles.input, value: step.model,
                onChange: (event) => { setStep((s) => ({ ...s, model: event.target.value })) },
              }, h('option', { value: '' }, '—'),
                ...step.models.map((id) => h('option', { key: id, value: id }, id)))),
          step.note.length === 0 ? null : h('p', { style: styles.error }, step.note),
          h('div', { style: styles.bar },
            h('button', {
              style: styles.button,
              disabled: busy || selected === undefined,
              onClick: findModels,
            }, t('welcomeFind')),
            h('button', {
              style: styles.primary,
              disabled: busy || selected === undefined,
              onClick: start,
            }, busy ? t('saving') : t('welcomeStart')),
            h('button', {
              style: styles.button,
              onClick: () => { setState({ status: 'hidden' }) },
            }, t('welcomeSkip')))))

    }

    /** Services this plugin needs before it can register anything. */
    const inject = ['slots', 'locale']

    /**
     * Register the dictionaries and the settings page.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'qialike-providers: dictionaries')
      const t = ctx.locale.bind(NS)
      // `inject` rather than a bare register: a slot exists only while the entry
      // that declares it is mounted, and registering into an undeclared slot
      // throws. The settings shell declares this one, and may mount after us.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'qialike.welcome',
        locale: NS,
      }, WelcomeOverlay))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'qialike-providers',
        // After `general` (0) and before `plugins` (15): the provider list is a
        // frequently opened page, and the CLI orders its own /models similarly.
        order: 20,
        // A thunk, resolved per projection, so the nav row follows the locale
        // without the entry being re-registered.
        label: () => t('nav'),
        // Declares the `t` seat on the component. Passing a bound translate
        // through `inject` instead would freeze the language at apply time.
        locale: NS,
      }, ProvidersSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
