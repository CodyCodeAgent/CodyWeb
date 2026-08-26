import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isSealedCredential, openCredential, sealCredential } from './credentialVault.js'
import { withLocalDatabase } from './localDatabase.js'

export const DEFAULT_FEISHU_BOT_ID = 'default'

export type FeishuBotStatus = 'connected' | 'connecting' | 'disconnected' | 'error'
export type FeishuConnectionState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

/** The stored representation includes the secret. Never return this type from an HTTP route. */
export type FeishuBotConfig = {
  id: string
  botId: string
  name: string
  appId: string
  appSecret: string
  platform: 'feishu' | 'lark'
  tenantId: string
  tenantName: string
  enabled: boolean
  allowAllUsers: boolean
  allowedOpenIds: string[]
  allowedChatIds: string[]
  groupMentionMode: 'always' | 'topic' | 'bound'
  p2pMode: 'topic' | 'chat'
  defaultProjectKey: string
  botOpenId: string
  botName: string
  status: FeishuBotStatus
  connectionState: FeishuConnectionState
  lastConnectedAtIso: string | null
  connectedAtIso: string | null
  lastHeartbeatAtIso: string | null
  lastError: string
  createdAtIso: string
  updatedAtIso: string
}

export type PublicFeishuBotConfig = Omit<FeishuBotConfig, 'appSecret'> & {
  secretConfigured: boolean
  /** @deprecated Use secretConfigured. */
  hasAppSecret: boolean
}

export type FeishuBindingScope = 'private' | 'group' | 'topic'

export type FeishuConversationBinding = {
  id: string
  bindingKey: string
  botId: string
  botName: string
  scopeType: FeishuBindingScope
  chatId: string
  rootId: string
  chatType: 'p2p' | 'group'
  projectCwd: string
  cwd: string
  projectName: string
  projectKey: string
  sessionId: string
  threadId: string
  sessionTitle: string
  threadTitle: string
  collaborationMode: 'default' | 'plan'
  permissionMode: 'normal' | 'yolo'
  userOpenId: string
  senderOpenId: string
  createdAtIso: string
  updatedAtIso: string
  lastMessageAtIso: string | null
}

export type PendingFeishuMessage = {
  id: string
  botId: string
  bindingKey: string
  messageId: string
  prompt: string
  payload: unknown
  createdAtIso: string
}

export type FeishuInboundEventStatus = 'processing' | 'processed' | 'failed'
export type FeishuInboundEvent = {
  botId: string
  eventKey: string
  eventType: string
  messageId: string
  chatId: string
  status: FeishuInboundEventStatus
  attempts: number
  payload: unknown
  receivedAtIso: string
  leaseExpiresAtIso: string | null
  processedAtIso: string | null
  lastError: string
}

export type FeishuOutboxStatus = 'pending' | 'sending' | 'sent' | 'failed'
export type FeishuOutboxItem = {
  id: string
  botId: string
  bindingKey: string
  kind: string
  targetId: string
  payload: unknown
  dedupeKey: string | null
  status: FeishuOutboxStatus
  attempts: number
  availableAtIso: string
  leaseExpiresAtIso: string | null
  remoteMessageId: string | null
  lastError: string
  createdAtIso: string
  updatedAtIso: string
  sentAtIso: string | null
  deadLetteredAtIso: string | null
}

export type FeishuTurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type FeishuTurn = {
  id: string
  botId: string
  bindingKey: string
  inboundMessageId: string
  sessionId: string
  turnId: string
  status: FeishuTurnStatus
  prompt: string
  responseText: string
  cardId: string | null
  lastError: string
  createdAtIso: string
  updatedAtIso: string
  completedAtIso: string | null
}

export type FeishuCardStatus = 'creating' | 'streaming' | 'completed' | 'failed' | 'cancelled'
export type FeishuCard = {
  id: string
  botId: string
  bindingKey: string
  messageId: string | null
  purpose: string
  status: FeishuCardStatus
  version: number
  state: unknown
  createdAtIso: string
  updatedAtIso: string
}

export type FeishuAuditLog = {
  id: string
  botId: string
  actorOpenId: string
  action: string
  targetType: string
  targetId: string
  success: boolean
  metadata: unknown
  error: string
  createdAtIso: string
}

export type FeishuAutoRoute = {
  id: string
  botId: string
  bindingKey: string
  chatId: string
  name: string
  enabled: boolean
  sourceSenderId: string
  sourceSenderType: 'app' | 'bot'
  messageType: 'interactive'
  cardTitle: string
  requiredKeywords: string[]
  fingerprintKey: string
  instruction: string
  projectKey: string
  projectCwd: string
  projectName: string
  sessionId: string
  sessionTitle: string
  createdByOpenId: string
  createdAtIso: string
  updatedAtIso: string
  lastMatchedAtIso: string | null
  matchCount: number
}

const BOT_STATUS_TO_CONNECTION: Record<FeishuBotStatus, FeishuConnectionState> = {
  connected: 'connected',
  connecting: 'connecting',
  disconnected: 'disabled',
  error: 'failed',
}

function nowIso(): string {
  return new Date().toISOString()
}

function clean(value: string | undefined, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function normalizeBotId(value?: string): string {
  return clean(value) || DEFAULT_FEISHU_BOT_ID
}

function uniqueStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)))
}

function parseJson(value: unknown, fallback: unknown = null): unknown {
  if (typeof value !== 'string' || !value) return fallback
  try { return JSON.parse(value) as unknown } catch { return fallback }
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function ensureFeishuTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feishu_bots (
      bot_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      app_id TEXT NOT NULL DEFAULT '',
      app_secret TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT 'feishu' CHECK (platform IN ('feishu', 'lark')),
      tenant_id TEXT NOT NULL DEFAULT '',
      tenant_name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      allow_all_users INTEGER NOT NULL DEFAULT 0 CHECK (allow_all_users IN (0, 1)),
      allowed_open_ids_json TEXT NOT NULL DEFAULT '[]',
      allowed_chat_ids_json TEXT NOT NULL DEFAULT '[]',
      group_mention_mode TEXT NOT NULL DEFAULT 'always' CHECK (group_mention_mode IN ('always', 'topic', 'bound')),
      p2p_mode TEXT NOT NULL DEFAULT 'topic' CHECK (p2p_mode IN ('topic', 'chat')),
      default_project_key TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feishu_bots_app_id_idx
      ON feishu_bots(app_id) WHERE app_id <> '';

    CREATE TABLE IF NOT EXISTS feishu_bot_runtime (
      bot_id TEXT PRIMARY KEY REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      bot_open_id TEXT NOT NULL DEFAULT '',
      bot_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'disconnected'
        CHECK (status IN ('connected', 'connecting', 'disconnected', 'error')),
      last_connected_at_iso TEXT,
      last_heartbeat_at_iso TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      updated_at_iso TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feishu_bindings (
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      scope_type TEXT NOT NULL CHECK (scope_type IN ('private', 'group', 'topic')),
      chat_id TEXT NOT NULL,
      root_id TEXT NOT NULL DEFAULT '',
      user_open_id TEXT NOT NULL DEFAULT '',
      project_key TEXT NOT NULL DEFAULT '',
      project_cwd TEXT NOT NULL,
      project_name TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL DEFAULT '',
      collaboration_mode TEXT NOT NULL DEFAULT 'default'
        CHECK (collaboration_mode IN ('default', 'plan')),
      permission_mode TEXT NOT NULL DEFAULT 'yolo'
        CHECK (permission_mode IN ('normal', 'yolo')),
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      last_message_at_iso TEXT,
      PRIMARY KEY (bot_id, binding_key)
    );
    CREATE INDEX IF NOT EXISTS feishu_bindings_session_idx ON feishu_bindings(session_id);
    CREATE INDEX IF NOT EXISTS feishu_bindings_activity_idx
      ON feishu_bindings(bot_id, last_message_at_iso DESC, updated_at_iso DESC);

    CREATE TABLE IF NOT EXISTS feishu_pending_messages_v2 (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT 'null',
      created_at_iso TEXT NOT NULL,
      claim_token TEXT,
      claim_expires_at_iso TEXT,
      UNIQUE (bot_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS feishu_pending_fifo_idx
      ON feishu_pending_messages_v2(bot_id, binding_key, created_at_iso, id);

    CREATE TABLE IF NOT EXISTS feishu_inbound_events (
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      event_key TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT '',
      message_id TEXT NOT NULL DEFAULT '',
      chat_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL DEFAULT 'null',
      received_at_iso TEXT NOT NULL,
      lease_expires_at_iso TEXT,
      processed_at_iso TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (bot_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS feishu_events_received_idx
      ON feishu_inbound_events(received_at_iso);

    CREATE TABLE IF NOT EXISTS feishu_outbox (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      dedupe_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at_iso TEXT NOT NULL,
      lease_expires_at_iso TEXT,
      remote_message_id TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      sent_at_iso TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feishu_outbox_dedupe_idx
      ON feishu_outbox(bot_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS feishu_outbox_claim_idx
      ON feishu_outbox(status, available_at_iso, lease_expires_at_iso);

    CREATE TABLE IF NOT EXISTS feishu_turns (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      inbound_message_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
      prompt TEXT NOT NULL DEFAULT '',
      response_text TEXT NOT NULL DEFAULT '',
      card_id TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      completed_at_iso TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feishu_turns_message_idx
      ON feishu_turns(bot_id, inbound_message_id) WHERE inbound_message_id <> '';
    CREATE INDEX IF NOT EXISTS feishu_turns_session_idx ON feishu_turns(session_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS feishu_cards (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL DEFAULT '',
      message_id TEXT,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('creating', 'streaming', 'completed', 'failed', 'cancelled')),
      version INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL DEFAULT 'null',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feishu_cards_message_idx ON feishu_cards(bot_id, message_id);

    CREATE TABLE IF NOT EXISTS feishu_audit_logs (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      actor_open_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT '',
      target_id TEXT NOT NULL DEFAULT '',
      success INTEGER NOT NULL DEFAULT 1 CHECK (success IN (0, 1)),
      metadata_json TEXT NOT NULL DEFAULT 'null',
      error TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS feishu_audit_bot_time_idx
      ON feishu_audit_logs(bot_id, created_at_iso DESC);

    CREATE TABLE IF NOT EXISTS feishu_auto_routes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES feishu_bots(bot_id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      source_sender_id TEXT NOT NULL,
      source_sender_type TEXT NOT NULL CHECK (source_sender_type IN ('app', 'bot')),
      message_type TEXT NOT NULL DEFAULT 'interactive' CHECK (message_type = 'interactive'),
      card_title TEXT NOT NULL,
      required_keywords_json TEXT NOT NULL DEFAULT '[]',
      fingerprint_key TEXT NOT NULL,
      instruction TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_cwd TEXT NOT NULL,
      project_name TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      session_title TEXT NOT NULL DEFAULT '',
      created_by_open_id TEXT NOT NULL DEFAULT '',
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      last_matched_at_iso TEXT,
      match_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (bot_id, chat_id, fingerprint_key)
    );
    CREATE INDEX IF NOT EXISTS feishu_auto_routes_match_idx
      ON feishu_auto_routes(bot_id, chat_id, enabled, updated_at_iso DESC);
  `)

  const outboxColumns = db.prepare('PRAGMA table_info(feishu_outbox)').all() as Array<{ name: string }>
  if (!outboxColumns.some((column) => column.name === 'dead_lettered_at_iso')) {
    db.exec('ALTER TABLE feishu_outbox ADD COLUMN dead_lettered_at_iso TEXT')
  }
  const botColumns = db.prepare('PRAGMA table_info(feishu_bots)').all() as Array<{ name: string }>
  if (!botColumns.some((column) => column.name === 'group_mention_mode')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN group_mention_mode TEXT NOT NULL DEFAULT 'always'")
  }
  if (!botColumns.some((column) => column.name === 'p2p_mode')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN p2p_mode TEXT NOT NULL DEFAULT 'topic'")
  }
  if (!botColumns.some((column) => column.name === 'allow_all_users')) {
    db.exec('ALTER TABLE feishu_bots ADD COLUMN allow_all_users INTEGER NOT NULL DEFAULT 0 CHECK (allow_all_users IN (0, 1))')
  }
  if (!botColumns.some((column) => column.name === 'platform')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN platform TEXT NOT NULL DEFAULT 'feishu' CHECK (platform IN ('feishu', 'lark'))")
  }
  if (!botColumns.some((column) => column.name === 'allowed_chat_ids_json')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN allowed_chat_ids_json TEXT NOT NULL DEFAULT '[]'")
  }
  if (!botColumns.some((column) => column.name === 'tenant_id')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN tenant_id TEXT NOT NULL DEFAULT ''")
  }
  if (!botColumns.some((column) => column.name === 'tenant_name')) {
    db.exec("ALTER TABLE feishu_bots ADD COLUMN tenant_name TEXT NOT NULL DEFAULT ''")
  }
  const bindingColumns = db.prepare('PRAGMA table_info(feishu_bindings)').all() as Array<{ name: string }>
  if (!bindingColumns.some((column) => column.name === 'collaboration_mode')) {
    db.exec("ALTER TABLE feishu_bindings ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'default' CHECK (collaboration_mode IN ('default', 'plan'))")
  }
  if (!bindingColumns.some((column) => column.name === 'permission_mode')) {
    db.exec("ALTER TABLE feishu_bindings ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'yolo' CHECK (permission_mode IN ('normal', 'yolo'))")
  }
  const pendingColumns = db.prepare('PRAGMA table_info(feishu_pending_messages_v2)').all() as Array<{ name: string }>
  if (!pendingColumns.some((column) => column.name === 'claim_token')) {
    db.exec('ALTER TABLE feishu_pending_messages_v2 ADD COLUMN claim_token TEXT')
  }
  if (!pendingColumns.some((column) => column.name === 'claim_expires_at_iso')) {
    db.exec('ALTER TABLE feishu_pending_messages_v2 ADD COLUMN claim_expires_at_iso TEXT')
  }

  migrateLegacySingleton(db)
  migratePlaintextBotSecrets(db)
}

function normalizeAutoRoute(row: Record<string, unknown>): FeishuAutoRoute {
  const keywords = parseJson(row.requiredKeywordsJson, [])
  return {
    id: String(row.id),
    botId: String(row.botId),
    bindingKey: String(row.bindingKey),
    chatId: String(row.chatId),
    name: String(row.name),
    enabled: row.enabled === 1,
    sourceSenderId: String(row.sourceSenderId),
    sourceSenderType: row.sourceSenderType === 'bot' ? 'bot' : 'app',
    messageType: 'interactive',
    cardTitle: String(row.cardTitle),
    requiredKeywords: Array.isArray(keywords) ? keywords.filter((value): value is string => typeof value === 'string') : [],
    fingerprintKey: String(row.fingerprintKey),
    instruction: String(row.instruction),
    projectKey: String(row.projectKey),
    projectCwd: String(row.projectCwd),
    projectName: String(row.projectName),
    sessionId: String(row.sessionId),
    sessionTitle: String(row.sessionTitle),
    createdByOpenId: String(row.createdByOpenId),
    createdAtIso: String(row.createdAtIso),
    updatedAtIso: String(row.updatedAtIso),
    lastMatchedAtIso: typeof row.lastMatchedAtIso === 'string' ? row.lastMatchedAtIso : null,
    matchCount: Number(row.matchCount) || 0,
  }
}

const AUTO_ROUTE_SELECT = `SELECT id, bot_id AS botId, binding_key AS bindingKey,
  chat_id AS chatId, name, enabled, source_sender_id AS sourceSenderId,
  source_sender_type AS sourceSenderType, message_type AS messageType,
  card_title AS cardTitle, required_keywords_json AS requiredKeywordsJson,
  fingerprint_key AS fingerprintKey, instruction, project_key AS projectKey,
  project_cwd AS projectCwd, project_name AS projectName, session_id AS sessionId,
  session_title AS sessionTitle, created_by_open_id AS createdByOpenId,
  created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso,
  last_matched_at_iso AS lastMatchedAtIso, match_count AS matchCount
  FROM feishu_auto_routes`

export async function listFeishuAutoRoutes(filter: { botId?: string; chatId?: string; enabled?: boolean } = {}): Promise<FeishuAutoRoute[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.botId) { clauses.push('bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    if (filter.chatId) { clauses.push('chat_id = ?'); params.push(filter.chatId.trim()) }
    if (filter.enabled !== undefined) { clauses.push('enabled = ?'); params.push(filter.enabled ? 1 : 0) }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`${AUTO_ROUTE_SELECT}${where} ORDER BY updated_at_iso DESC`).all(...params) as Record<string, unknown>[])
      .map(normalizeAutoRoute)
  })
}

export async function upsertFeishuAutoRoute(input: {
  id?: string
  botId: string
  chatId: string
  name: string
  enabled?: boolean
  sourceSenderId: string
  sourceSenderType: 'app' | 'bot'
  cardTitle: string
  requiredKeywords: string[]
  fingerprintKey: string
  instruction: string
  projectKey: string
  projectCwd: string
  projectName: string
  sessionId: string
  sessionTitle: string
  createdByOpenId: string
}): Promise<FeishuAutoRoute> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(input.botId)
    ensureBotExists(db, botId)
    const existing = db.prepare(`${AUTO_ROUTE_SELECT} WHERE bot_id = ? AND chat_id = ? AND fingerprint_key = ?`)
      .get(botId, input.chatId.trim(), input.fingerprintKey.trim()) as Record<string, unknown> | undefined
    const timestamp = nowIso()
    const id = existing ? String(existing.id) : input.id ?? randomUUID()
    const bindingKey = existing ? String(existing.bindingKey) : `${botId}:auto-route:${id}`
    db.prepare(`
      INSERT INTO feishu_auto_routes
        (id, bot_id, binding_key, chat_id, name, enabled, source_sender_id,
         source_sender_type, message_type, card_title, required_keywords_json,
         fingerprint_key, instruction, project_key, project_cwd, project_name,
         session_id, session_title, created_by_open_id, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'interactive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, chat_id, fingerprint_key) DO UPDATE SET
        name = excluded.name, enabled = excluded.enabled,
        source_sender_id = excluded.source_sender_id,
        source_sender_type = excluded.source_sender_type,
        card_title = excluded.card_title,
        required_keywords_json = excluded.required_keywords_json,
        instruction = excluded.instruction, project_key = excluded.project_key,
        project_cwd = excluded.project_cwd, project_name = excluded.project_name,
        session_id = excluded.session_id, session_title = excluded.session_title,
        created_by_open_id = excluded.created_by_open_id,
        updated_at_iso = excluded.updated_at_iso
    `).run(
      id, botId, bindingKey, input.chatId.trim(), clean(input.name, input.cardTitle), input.enabled === false ? 0 : 1,
      input.sourceSenderId.trim(), input.sourceSenderType, input.cardTitle.trim(),
      stringifyJson(uniqueStrings(input.requiredKeywords)), input.fingerprintKey.trim(), input.instruction.trim(),
      input.projectKey.trim(), input.projectCwd.trim(), input.projectName.trim(), input.sessionId.trim(),
      input.sessionTitle.trim(), input.createdByOpenId.trim(), existing ? String(existing.createdAtIso) : timestamp, timestamp,
    )
    return normalizeAutoRoute(db.prepare(`${AUTO_ROUTE_SELECT} WHERE bot_id = ? AND chat_id = ? AND fingerprint_key = ?`)
      .get(botId, input.chatId.trim(), input.fingerprintKey.trim()) as Record<string, unknown>)
  })
}

export async function setFeishuAutoRouteEnabled(id: string, enabled: boolean): Promise<FeishuAutoRoute | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const changed = db.prepare('UPDATE feishu_auto_routes SET enabled = ?, updated_at_iso = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), id.trim()).changes
    if (!changed) return null
    return normalizeAutoRoute(db.prepare(`${AUTO_ROUTE_SELECT} WHERE id = ?`).get(id.trim()) as Record<string, unknown>)
  })
}

export async function updateFeishuAutoRouteDefinition(input: {
  id: string
  requiredKeywords: string[]
  instruction: string
}): Promise<FeishuAutoRoute | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const route = db.prepare(`${AUTO_ROUTE_SELECT} WHERE id = ?`).get(input.id.trim()) as Record<string, unknown> | undefined
    if (!route) return null
    db.prepare(`UPDATE feishu_auto_routes SET required_keywords_json = ?, instruction = ?,
      updated_at_iso = ? WHERE id = ?`)
      .run(
        stringifyJson(uniqueStrings(input.requiredKeywords).slice(0, 8)),
        input.instruction.trim(),
        nowIso(),
        input.id.trim(),
      )
    return normalizeAutoRoute(db.prepare(`${AUTO_ROUTE_SELECT} WHERE id = ?`).get(input.id.trim()) as Record<string, unknown>)
  })
}

export async function touchFeishuAutoRoute(id: string): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.prepare(`UPDATE feishu_auto_routes SET match_count = match_count + 1,
      last_matched_at_iso = ?, updated_at_iso = ? WHERE id = ? AND enabled = 1`)
      .run(timestamp, timestamp, id.trim()).changes > 0
  })
}

export async function deleteFeishuAutoRoute(id: string): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const transaction = db.transaction(() => {
      const route = db.prepare('SELECT bot_id AS botId, binding_key AS bindingKey FROM feishu_auto_routes WHERE id = ?')
        .get(id.trim()) as { botId: string; bindingKey: string } | undefined
      if (!route) return false
      db.prepare('DELETE FROM feishu_auto_routes WHERE id = ?').run(id.trim())
      db.prepare('DELETE FROM feishu_pending_messages_v2 WHERE bot_id = ? AND binding_key = ?').run(route.botId, route.bindingKey)
      db.prepare('DELETE FROM feishu_bindings WHERE bot_id = ? AND binding_key = ?').run(route.botId, route.bindingKey)
      return true
    })
    return transaction()
  })
}

function secretContext(botId: string): string {
  return `feishu-bot:${botId}:app-secret`
}

function migratePlaintextBotSecrets(db: Database.Database): void {
  const rows = db.prepare("SELECT bot_id AS botId, app_secret AS appSecret FROM feishu_bots WHERE app_secret <> ''").all() as Array<{ botId: string; appSecret: string }>
  const update = db.prepare('UPDATE feishu_bots SET app_secret = ? WHERE bot_id = ?')
  const migrate = db.transaction(() => {
    for (const row of rows) {
      if (!isSealedCredential(row.appSecret)) update.run(sealCredential(row.appSecret, secretContext(row.botId)), row.botId)
    }
  })
  migrate()
}

function migrateLegacySingleton(db: Database.Database): void {
  if (!tableExists(db, 'feishu_bot_config')) return
  const legacy = db.prepare(`
    SELECT app_id AS appId, app_secret AS appSecret, enabled,
      allowed_open_ids_json AS allowedOpenIdsJson, bot_open_id AS botOpenId,
      bot_name AS botName, connection_state AS connectionState,
      last_error AS lastError, connected_at_iso AS connectedAtIso,
      updated_at_iso AS updatedAtIso
    FROM feishu_bot_config WHERE singleton_id = 1
  `).get() as Record<string, unknown> | undefined
  if (!legacy) return
  const timestamp = typeof legacy.updatedAtIso === 'string' ? legacy.updatedAtIso : nowIso()
  db.prepare(`
    INSERT OR IGNORE INTO feishu_bots
      (bot_id, name, app_id, app_secret, enabled, allowed_open_ids_json,
       default_project_key, created_at_iso, updated_at_iso)
    VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
  `).run(
    DEFAULT_FEISHU_BOT_ID,
    typeof legacy.botName === 'string' && legacy.botName ? legacy.botName : '飞书机器人',
    typeof legacy.appId === 'string' ? legacy.appId : '',
    typeof legacy.appSecret === 'string' ? legacy.appSecret : '',
    legacy.enabled === 1 ? 1 : 0,
    typeof legacy.allowedOpenIdsJson === 'string' ? legacy.allowedOpenIdsJson : '[]',
    timestamp,
    timestamp,
  )
  const state = typeof legacy.connectionState === 'string' ? legacy.connectionState : 'disabled'
  const status: FeishuBotStatus = state === 'connected' ? 'connected' : state === 'connecting' || state === 'reconnecting' ? 'connecting' : state === 'failed' ? 'error' : 'disconnected'
  db.prepare(`
    INSERT OR IGNORE INTO feishu_bot_runtime
      (bot_id, bot_open_id, bot_name, status, last_connected_at_iso,
       last_heartbeat_at_iso, last_error, updated_at_iso)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    DEFAULT_FEISHU_BOT_ID,
    typeof legacy.botOpenId === 'string' ? legacy.botOpenId : '',
    typeof legacy.botName === 'string' ? legacy.botName : '',
    status,
    typeof legacy.connectedAtIso === 'string' ? legacy.connectedAtIso : null,
    typeof legacy.lastError === 'string' ? legacy.lastError : '',
    timestamp,
  )
}

function ensureBotExists(db: Database.Database, botId: string): void {
  const timestamp = nowIso()
  db.prepare(`
    INSERT OR IGNORE INTO feishu_bots
      (bot_id, name, created_at_iso, updated_at_iso)
    VALUES (?, ?, ?, ?)
  `).run(botId, botId === DEFAULT_FEISHU_BOT_ID ? '飞书机器人' : botId, timestamp, timestamp)
  db.prepare(`
    INSERT OR IGNORE INTO feishu_bot_runtime (bot_id, updated_at_iso) VALUES (?, ?)
  `).run(botId, timestamp)
}

type BotRow = Record<string, unknown>

function normalizeBot(row: BotRow): FeishuBotConfig {
  const id = String(row.id)
  const status = (['connected', 'connecting', 'disconnected', 'error'].includes(String(row.status))
    ? String(row.status) : 'disconnected') as FeishuBotStatus
  const allowed = parseJson(row.allowedOpenIdsJson, [])
  const allowedOpenIds = Array.isArray(allowed)
    ? uniqueStrings(allowed.filter((item): item is string => typeof item === 'string'))
    : []
  const allowedChats = parseJson(row.allowedChatIdsJson, [])
  const allowedChatIds = Array.isArray(allowedChats)
    ? uniqueStrings(allowedChats.filter((item): item is string => typeof item === 'string'))
    : []
  const lastConnectedAtIso = typeof row.lastConnectedAtIso === 'string' ? row.lastConnectedAtIso : null
  return {
    id,
    botId: id,
    name: typeof row.name === 'string' ? row.name : '',
    appId: typeof row.appId === 'string' ? row.appId : '',
    appSecret: typeof row.appSecret === 'string' ? openCredential(row.appSecret, secretContext(id)) : '',
    platform: row.platform === 'lark' ? 'lark' : 'feishu',
    tenantId: typeof row.tenantId === 'string' ? row.tenantId : '',
    tenantName: typeof row.tenantName === 'string' ? row.tenantName : '',
    enabled: row.enabled === 1,
    allowAllUsers: row.allowAllUsers === 1,
    allowedOpenIds,
    allowedChatIds,
    groupMentionMode: row.groupMentionMode === 'topic' || row.groupMentionMode === 'bound' ? row.groupMentionMode : 'always',
    p2pMode: row.p2pMode === 'chat' ? 'chat' : 'topic',
    defaultProjectKey: typeof row.defaultProjectKey === 'string' ? row.defaultProjectKey : '',
    botOpenId: typeof row.botOpenId === 'string' ? row.botOpenId : '',
    botName: typeof row.botName === 'string' ? row.botName : '',
    status,
    connectionState: BOT_STATUS_TO_CONNECTION[status],
    lastConnectedAtIso,
    connectedAtIso: lastConnectedAtIso,
    lastHeartbeatAtIso: typeof row.lastHeartbeatAtIso === 'string' ? row.lastHeartbeatAtIso : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : '',
    createdAtIso: String(row.createdAtIso),
    updatedAtIso: String(row.updatedAtIso),
  }
}

const BOT_SELECT = `
  SELECT b.bot_id AS id, b.name, b.app_id AS appId, b.app_secret AS appSecret,
    b.platform, b.tenant_id AS tenantId, b.tenant_name AS tenantName,
    b.enabled, b.allow_all_users AS allowAllUsers,
    b.allowed_open_ids_json AS allowedOpenIdsJson,
    b.allowed_chat_ids_json AS allowedChatIdsJson, b.group_mention_mode AS groupMentionMode,
    b.p2p_mode AS p2pMode,
    b.default_project_key AS defaultProjectKey,
    r.bot_open_id AS botOpenId, r.bot_name AS botName,
    COALESCE(r.status, 'disconnected') AS status,
    r.last_connected_at_iso AS lastConnectedAtIso,
    r.last_heartbeat_at_iso AS lastHeartbeatAtIso,
    COALESCE(r.last_error, '') AS lastError,
    b.created_at_iso AS createdAtIso, b.updated_at_iso AS updatedAtIso
  FROM feishu_bots b LEFT JOIN feishu_bot_runtime r ON r.bot_id = b.bot_id
`

export async function listFeishuBots(): Promise<FeishuBotConfig[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return (db.prepare(`${BOT_SELECT} ORDER BY b.created_at_iso, b.bot_id`).all() as BotRow[]).map(normalizeBot)
  })
}

export async function findFeishuBot(botId: string): Promise<FeishuBotConfig | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const row = db.prepare(`${BOT_SELECT} WHERE b.bot_id = ?`).get(normalizeBotId(botId)) as BotRow | undefined
    return row ? normalizeBot(row) : null
  })
}

export async function readFeishuBotConfig(botId = DEFAULT_FEISHU_BOT_ID): Promise<FeishuBotConfig> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const id = normalizeBotId(botId)
    ensureBotExists(db, id)
    return normalizeBot(db.prepare(`${BOT_SELECT} WHERE b.bot_id = ?`).get(id) as BotRow)
  })
}

export function publicFeishuBotConfig(config: FeishuBotConfig): PublicFeishuBotConfig {
  const { appSecret, ...safe } = config
  const configured = appSecret.length > 0
  return { ...safe, secretConfigured: configured, hasAppSecret: configured }
}

export async function upsertFeishuBot(input: {
  id?: string
  botId?: string
  name?: string
  appId: string
  appSecret?: string
  platform?: 'feishu' | 'lark'
  tenantId?: string
  tenantName?: string
  enabled: boolean
  allowAllUsers?: boolean
  allowedOpenIds?: string[]
  allowedChatIds?: string[]
  groupMentionMode?: 'always' | 'topic' | 'bound'
  p2pMode?: 'topic' | 'chat'
  defaultProjectKey?: string
}): Promise<FeishuBotConfig> {
  const id = normalizeBotId(input.id ?? input.botId)
  const timestamp = nowIso()
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const previous = db.prepare('SELECT app_secret AS appSecret, platform, tenant_id AS tenantId, tenant_name AS tenantName, allow_all_users AS allowAllUsers, allowed_open_ids_json AS allowedOpenIdsJson, allowed_chat_ids_json AS allowedChatIdsJson, group_mention_mode AS groupMentionMode, p2p_mode AS p2pMode, created_at_iso AS createdAtIso FROM feishu_bots WHERE bot_id = ?').get(id) as { appSecret: string; platform: 'feishu' | 'lark'; tenantId: string; tenantName: string; allowAllUsers: number; allowedOpenIdsJson: string; allowedChatIdsJson: string; groupMentionMode: 'always' | 'topic' | 'bound'; p2pMode: 'topic' | 'chat'; createdAtIso: string } | undefined
    const secret = input.appSecret === undefined
      ? previous?.appSecret ?? ''
      : sealCredential(input.appSecret.trim(), secretContext(id))
    const name = clean(input.name, id === DEFAULT_FEISHU_BOT_ID ? '飞书机器人' : id)
    const transaction = db.transaction(() => {
      db.prepare(`
        INSERT INTO feishu_bots
          (bot_id, name, app_id, app_secret, platform, tenant_id, tenant_name, enabled, allow_all_users,
           allowed_open_ids_json, allowed_chat_ids_json, group_mention_mode, p2p_mode, default_project_key, created_at_iso, updated_at_iso)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
          name = excluded.name, app_id = excluded.app_id, app_secret = excluded.app_secret,
          platform = excluded.platform, tenant_id = excluded.tenant_id, tenant_name = excluded.tenant_name,
          enabled = excluded.enabled, allow_all_users = excluded.allow_all_users,
          allowed_open_ids_json = excluded.allowed_open_ids_json,
          allowed_chat_ids_json = excluded.allowed_chat_ids_json,
          group_mention_mode = excluded.group_mention_mode,
          p2p_mode = excluded.p2p_mode,
          default_project_key = excluded.default_project_key, updated_at_iso = excluded.updated_at_iso
      `).run(id, name, input.appId.trim(), secret, input.platform ?? previous?.platform ?? 'feishu',
        clean(input.tenantId, previous?.tenantId ?? ''), clean(input.tenantName, previous?.tenantName ?? ''), input.enabled ? 1 : 0,
        input.allowAllUsers === undefined ? previous?.allowAllUsers ?? 0 : input.allowAllUsers ? 1 : 0,
        stringifyJson(input.allowedOpenIds === undefined ? parseJson(previous?.allowedOpenIdsJson, []) : uniqueStrings(input.allowedOpenIds)),
        stringifyJson(input.allowedChatIds === undefined ? parseJson(previous?.allowedChatIdsJson, []) : uniqueStrings(input.allowedChatIds)),
        input.groupMentionMode ?? previous?.groupMentionMode ?? 'always', input.p2pMode ?? previous?.p2pMode ?? 'topic', clean(input.defaultProjectKey),
        previous?.createdAtIso ?? timestamp, timestamp)
      db.prepare(`
        INSERT INTO feishu_bot_runtime (bot_id, status, updated_at_iso)
        VALUES (?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
          status = CASE WHEN ? = 0 THEN 'disconnected'
                        WHEN feishu_bot_runtime.status = 'disconnected' THEN 'connecting'
                        ELSE feishu_bot_runtime.status END,
          last_error = CASE WHEN ? = 0 THEN '' ELSE feishu_bot_runtime.last_error END,
          updated_at_iso = excluded.updated_at_iso
      `).run(id, input.enabled ? 'connecting' : 'disconnected', timestamp,
        input.enabled ? 1 : 0, input.enabled ? 1 : 0)
    })
    transaction()
    return normalizeBot(db.prepare(`${BOT_SELECT} WHERE b.bot_id = ?`).get(id) as BotRow)
  })
}

/** Atomically grants one exact Feishu identity without ever enabling broad access. */
export async function grantFeishuBotUserAccess(botId: string, openId: string): Promise<FeishuBotConfig> {
  const id = normalizeBotId(botId)
  const normalizedOpenId = openId.trim()
  if (!/^ou_[A-Za-z0-9_-]+$/u.test(normalizedOpenId)) throw new Error('Invalid Feishu open_id')
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const transaction = db.transaction(() => {
      const row = db.prepare('SELECT allowed_open_ids_json AS allowedOpenIdsJson FROM feishu_bots WHERE bot_id = ?').get(id) as { allowedOpenIdsJson: string } | undefined
      if (!row) throw new Error('Feishu bot not found')
      const parsed = parseJson(row.allowedOpenIdsJson, [])
      const existing = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
      const allowedOpenIds = uniqueStrings([...existing, normalizedOpenId])
      db.prepare(`
        UPDATE feishu_bots
        SET allow_all_users = 0, allowed_open_ids_json = ?, updated_at_iso = ?
        WHERE bot_id = ?
      `).run(stringifyJson(allowedOpenIds), nowIso(), id)
    })
    transaction()
    return normalizeBot(db.prepare(`${BOT_SELECT} WHERE b.bot_id = ?`).get(id) as BotRow)
  })
}

/** Compatibility wrapper for the original single-bot API. */
export async function saveFeishuBotConfig(input: {
  id?: string
  botId?: string
  name?: string
  appId: string
  appSecret?: string
  enabled: boolean
  allowAllUsers?: boolean
  allowedOpenIds: string[]
  defaultProjectKey?: string
}): Promise<FeishuBotConfig> {
  return upsertFeishuBot(input)
}

export async function deleteFeishuBot(botId: string): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return db.prepare('DELETE FROM feishu_bots WHERE bot_id = ?').run(normalizeBotId(botId)).changes > 0
  })
}

export async function updateFeishuBotRuntime(input: {
  botId?: string
  status?: FeishuBotStatus
  connectionState?: FeishuConnectionState
  lastError?: string
  botOpenId?: string
  botName?: string
  lastConnectedAtIso?: string | null
  connectedAtIso?: string | null
  lastHeartbeatAtIso?: string | null
}): Promise<FeishuBotConfig> {
  const botId = normalizeBotId(input.botId)
  const status = input.status ?? (input.connectionState === 'connected' ? 'connected'
    : input.connectionState === 'connecting' || input.connectionState === 'reconnecting' ? 'connecting'
      : input.connectionState === 'failed' ? 'error' : 'disconnected')
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    ensureBotExists(db, botId)
    const current = db.prepare('SELECT * FROM feishu_bot_runtime WHERE bot_id = ?').get(botId) as Record<string, unknown>
    const timestamp = nowIso()
    const lastConnected = input.lastConnectedAtIso ?? input.connectedAtIso
      ?? (status === 'connected' ? timestamp : typeof current.last_connected_at_iso === 'string' ? current.last_connected_at_iso : null)
    db.prepare(`
      UPDATE feishu_bot_runtime SET bot_open_id = ?, bot_name = ?, status = ?,
        last_connected_at_iso = ?, last_heartbeat_at_iso = ?, last_error = ?, updated_at_iso = ?
      WHERE bot_id = ?
    `).run(
      input.botOpenId ?? current.bot_open_id ?? '', input.botName ?? current.bot_name ?? '', status,
      lastConnected,
      input.lastHeartbeatAtIso === undefined ? current.last_heartbeat_at_iso ?? null : input.lastHeartbeatAtIso,
      input.lastError ?? current.last_error ?? '', timestamp, botId,
    )
    return normalizeBot(db.prepare(`${BOT_SELECT} WHERE b.bot_id = ?`).get(botId) as BotRow)
  })
}

type BindingInput = {
  id?: string
  bindingKey?: string
  botId?: string
  scopeType?: FeishuBindingScope
  chatId: string
  rootId?: string
  chatType?: 'p2p' | 'group'
  projectCwd?: string
  cwd?: string
  projectName?: string
  projectKey?: string
  sessionId?: string
  threadId?: string
  sessionTitle?: string
  threadTitle?: string
  collaborationMode?: 'default' | 'plan'
  permissionMode?: 'normal' | 'yolo'
  userOpenId?: string
  senderOpenId?: string
}

function normalizeBinding(row: Record<string, unknown>): FeishuConversationBinding {
  const id = String(row.bindingKey)
  const scopeType = String(row.scopeType) as FeishuBindingScope
  const projectCwd = String(row.projectCwd)
  const projectKey = typeof row.projectKey === 'string' && row.projectKey ? row.projectKey : projectCwd
  const sessionId = String(row.sessionId)
  const sessionTitle = String(row.sessionTitle ?? '')
  const userOpenId = String(row.userOpenId ?? '')
  const collaborationMode = row.collaborationMode === 'plan' ? 'plan' : 'default'
  const permissionMode = row.permissionMode === 'normal' ? 'normal' : 'yolo'
  return {
    id, bindingKey: id, botId: String(row.botId), botName: String(row.botName ?? ''), scopeType,
    chatId: String(row.chatId), rootId: String(row.rootId ?? ''),
    chatType: scopeType === 'private' ? 'p2p' : 'group', projectCwd, cwd: projectCwd,
    projectName: String(row.projectName ?? ''), projectKey, sessionId, threadId: sessionId,
    sessionTitle, threadTitle: sessionTitle, collaborationMode, permissionMode, userOpenId, senderOpenId: userOpenId,
    createdAtIso: String(row.createdAtIso), updatedAtIso: String(row.updatedAtIso),
    lastMessageAtIso: typeof row.lastMessageAtIso === 'string' ? row.lastMessageAtIso : null,
  }
}

const BINDING_SELECT = `
  SELECT x.binding_key AS bindingKey, x.bot_id AS botId, b.name AS botName,
    x.scope_type AS scopeType, x.chat_id AS chatId, x.root_id AS rootId,
    x.user_open_id AS userOpenId, x.project_key AS projectKey,
    x.project_cwd AS projectCwd, x.project_name AS projectName,
    x.session_id AS sessionId, x.session_title AS sessionTitle,
    x.collaboration_mode AS collaborationMode, x.permission_mode AS permissionMode,
    x.created_at_iso AS createdAtIso, x.updated_at_iso AS updatedAtIso,
    x.last_message_at_iso AS lastMessageAtIso
  FROM feishu_bindings x JOIN feishu_bots b ON b.bot_id = x.bot_id
`

export async function listFeishuBindings(filter: { botId?: string; sessionId?: string; threadId?: string } = {}): Promise<FeishuConversationBinding[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: string[] = []
    if (filter.botId) { clauses.push('x.bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    const sessionId = filter.sessionId ?? filter.threadId
    if (sessionId) { clauses.push('x.session_id = ?'); params.push(sessionId.trim()) }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    return (db.prepare(`${BINDING_SELECT}${where} ORDER BY COALESCE(x.last_message_at_iso, x.updated_at_iso) DESC`).all(...params) as Record<string, unknown>[]).map(normalizeBinding)
  })
}

export async function findFeishuBinding(bindingKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<FeishuConversationBinding | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const row = db.prepare(`${BINDING_SELECT} WHERE x.bot_id = ? AND x.binding_key = ?`).get(normalizeBotId(botId), bindingKey.trim()) as Record<string, unknown> | undefined
    return row ? normalizeBinding(row) : null
  })
}

export async function upsertFeishuBinding(input: BindingInput): Promise<FeishuConversationBinding> {
  const botId = normalizeBotId(input.botId)
  const bindingKey = clean(input.bindingKey ?? input.id)
  if (!bindingKey) throw new Error('Feishu bindingKey is required')
  const projectCwd = clean(input.projectCwd ?? input.cwd)
  const sessionId = clean(input.sessionId ?? input.threadId)
  if (!projectCwd || !sessionId) throw new Error('Feishu binding projectCwd and sessionId are required')
  const scopeType = input.scopeType ?? (input.chatType === 'p2p' ? 'private' : input.rootId ? 'topic' : 'group')
  const timestamp = nowIso()
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    ensureBotExists(db, botId)
    const existing = db.prepare('SELECT created_at_iso AS createdAtIso, collaboration_mode AS collaborationMode, permission_mode AS permissionMode FROM feishu_bindings WHERE bot_id = ? AND binding_key = ?').get(botId, bindingKey) as { createdAtIso: string; collaborationMode: 'default' | 'plan'; permissionMode: 'normal' | 'yolo' } | undefined
    const collaborationMode = input.collaborationMode ?? existing?.collaborationMode ?? 'default'
    const permissionMode = input.permissionMode ?? existing?.permissionMode ?? 'yolo'
    db.prepare(`
      INSERT INTO feishu_bindings
        (bot_id, binding_key, scope_type, chat_id, root_id, user_open_id,
         project_key, project_cwd, project_name, session_id, session_title,
         collaboration_mode, permission_mode, created_at_iso, updated_at_iso, last_message_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(bot_id, binding_key) DO UPDATE SET
        scope_type = excluded.scope_type, chat_id = excluded.chat_id, root_id = excluded.root_id,
        user_open_id = excluded.user_open_id, project_key = excluded.project_key,
        project_cwd = excluded.project_cwd, project_name = excluded.project_name,
        session_id = excluded.session_id, session_title = excluded.session_title,
        collaboration_mode = excluded.collaboration_mode,
        permission_mode = excluded.permission_mode,
        updated_at_iso = excluded.updated_at_iso
    `).run(botId, bindingKey, scopeType, input.chatId.trim(), clean(input.rootId),
      clean(input.userOpenId ?? input.senderOpenId), clean(input.projectKey, projectCwd), projectCwd,
      clean(input.projectName), sessionId, clean(input.sessionTitle ?? input.threadTitle),
      collaborationMode, permissionMode, existing?.createdAtIso ?? timestamp, timestamp)
    return normalizeBinding(db.prepare(`${BINDING_SELECT} WHERE x.bot_id = ? AND x.binding_key = ?`).get(botId, bindingKey) as Record<string, unknown>)
  })
}

export async function touchFeishuBinding(bindingKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.prepare('UPDATE feishu_bindings SET last_message_at_iso = ?, updated_at_iso = ? WHERE bot_id = ? AND binding_key = ?')
      .run(timestamp, timestamp, normalizeBotId(botId), bindingKey.trim()).changes > 0
  })
}

export async function deleteFeishuBinding(bindingKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const id = normalizeBotId(botId)
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM feishu_pending_messages_v2 WHERE bot_id = ? AND binding_key = ?').run(id, bindingKey.trim())
      return db.prepare('DELETE FROM feishu_bindings WHERE bot_id = ? AND binding_key = ?').run(id, bindingKey.trim()).changes > 0
    })
    return transaction()
  })
}

function normalizePending(row: Record<string, unknown>): PendingFeishuMessage {
  return { id: String(row.id), botId: String(row.botId), bindingKey: String(row.bindingKey),
    messageId: String(row.messageId), prompt: String(row.prompt), payload: parseJson(row.payloadJson),
    createdAtIso: String(row.createdAtIso) }
}

const PENDING_SELECT = `SELECT id, bot_id AS botId, binding_key AS bindingKey,
  message_id AS messageId, prompt, payload_json AS payloadJson,
  created_at_iso AS createdAtIso FROM feishu_pending_messages_v2`

export async function savePendingFeishuMessage(message: Omit<PendingFeishuMessage, 'id' | 'payload' | 'botId'> & { id?: string; payload?: unknown; botId?: string }): Promise<PendingFeishuMessage> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(message.botId)
    ensureBotExists(db, botId)
    db.prepare(`
      INSERT INTO feishu_pending_messages_v2
        (id, bot_id, binding_key, message_id, prompt, payload_json, created_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, message_id) DO UPDATE SET
        binding_key = excluded.binding_key, prompt = excluded.prompt, payload_json = excluded.payload_json
    `).run(message.id ?? randomUUID(), botId, message.bindingKey, message.messageId, message.prompt,
      stringifyJson(message.payload), message.createdAtIso)
    return normalizePending(db.prepare(`${PENDING_SELECT} WHERE bot_id = ? AND message_id = ?`)
      .get(botId, message.messageId) as Record<string, unknown>)
  })
}

export async function takePendingFeishuMessage(bindingKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<PendingFeishuMessage | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const transaction = db.transaction(() => {
      const row = db.prepare(`${PENDING_SELECT} WHERE bot_id = ? AND binding_key = ?
        ORDER BY created_at_iso, id LIMIT 1`)
        .get(normalizeBotId(botId), bindingKey.trim()) as Record<string, unknown> | undefined
      if (!row) return null
      db.prepare('DELETE FROM feishu_pending_messages_v2 WHERE id = ?').run(row.id)
      return normalizePending(row)
    })
    return transaction()
  })
}

export async function peekPendingFeishuMessage(bindingKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<PendingFeishuMessage | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const row = db.prepare(`${PENDING_SELECT} WHERE bot_id = ? AND binding_key = ?
      ORDER BY created_at_iso, id LIMIT 1`)
      .get(normalizeBotId(botId), bindingKey.trim()) as Record<string, unknown> | undefined
    return row ? normalizePending(row) : null
  })
}

/** Delete one exact pending message after its durable turn has been prepared. */
export async function deletePendingFeishuMessage(messageId: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return db.prepare('DELETE FROM feishu_pending_messages_v2 WHERE bot_id = ? AND message_id = ?')
      .run(normalizeBotId(botId), messageId.trim()).changes > 0
  })
}

/** Lease the oldest pending selection so mutually exclusive card options cannot race across processes. */
export async function claimPendingFeishuMessage(
  bindingKey: string,
  botId: string,
  claimToken: string,
  leaseMs = 15 * 60_000,
): Promise<PendingFeishuMessage | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const id = normalizeBotId(botId)
    const now = nowIso()
    const expiresAtIso = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString()
    return db.transaction(() => {
      const row = db.prepare(`${PENDING_SELECT} WHERE bot_id = ? AND binding_key = ?
        ORDER BY created_at_iso, id LIMIT 1`)
        .get(id, bindingKey.trim()) as Record<string, unknown> | undefined
      if (!row) return null
      const claimed = db.prepare(`UPDATE feishu_pending_messages_v2
        SET claim_token = ?, claim_expires_at_iso = ?
        WHERE id = ? AND (claim_token IS NULL OR claim_expires_at_iso IS NULL OR claim_expires_at_iso <= ?)`)
        .run(claimToken, expiresAtIso, row.id, now).changes > 0
      return claimed ? normalizePending(row) : null
    })()
  })
}

export async function releasePendingFeishuMessageClaim(claimToken: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return db.prepare(`UPDATE feishu_pending_messages_v2
      SET claim_token = NULL, claim_expires_at_iso = NULL
      WHERE bot_id = ? AND claim_token = ?`)
      .run(normalizeBotId(botId), claimToken).changes > 0
  })
}

function normalizeInbound(row: Record<string, unknown>): FeishuInboundEvent {
  return { botId: String(row.botId), eventKey: String(row.eventKey), eventType: String(row.eventType),
    messageId: String(row.messageId), chatId: String(row.chatId), status: row.status as FeishuInboundEventStatus,
    attempts: Number(row.attempts), payload: parseJson(row.payloadJson), receivedAtIso: String(row.receivedAtIso),
    leaseExpiresAtIso: typeof row.leaseExpiresAtIso === 'string' ? row.leaseExpiresAtIso : null,
    processedAtIso: typeof row.processedAtIso === 'string' ? row.processedAtIso : null,
    lastError: String(row.lastError ?? '') }
}

const EVENT_SELECT = `SELECT bot_id AS botId, event_key AS eventKey, event_type AS eventType,
  message_id AS messageId, chat_id AS chatId, status, attempts, payload_json AS payloadJson,
  received_at_iso AS receivedAtIso, lease_expires_at_iso AS leaseExpiresAtIso,
  processed_at_iso AS processedAtIso, last_error AS lastError FROM feishu_inbound_events`

export async function claimFeishuInboundEvent(input: {
  botId?: string
  eventKey: string
  eventType?: string
  messageId?: string
  chatId?: string
  payload?: unknown
  leaseMs?: number
  retentionMs?: number
}): Promise<FeishuInboundEvent | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(input.botId)
    ensureBotExists(db, botId)
    const now = new Date()
    const timestamp = now.toISOString()
    const leaseExpires = new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 60_000)).toISOString()
    const cutoff = new Date(now.getTime() - (input.retentionMs ?? 7 * 24 * 60 * 60_000)).toISOString()
    const transaction = db.transaction(() => {
      db.prepare("DELETE FROM feishu_inbound_events WHERE status != 'processing' AND received_at_iso < ?").run(cutoff)
      const existing = db.prepare(`${EVENT_SELECT} WHERE bot_id = ? AND event_key = ?`).get(botId, input.eventKey) as Record<string, unknown> | undefined
      if (existing) {
        if (existing.status === 'processed') return null
        const lease = typeof existing.leaseExpiresAtIso === 'string' ? existing.leaseExpiresAtIso : ''
        if (existing.status === 'processing' && lease > timestamp) return null
        db.prepare(`
          UPDATE feishu_inbound_events SET status = 'processing', attempts = attempts + 1,
            lease_expires_at_iso = ?, processed_at_iso = NULL, last_error = '',
            event_type = ?, message_id = ?, chat_id = ?, payload_json = ?
          WHERE bot_id = ? AND event_key = ?
        `).run(leaseExpires, clean(input.eventType), clean(input.messageId), clean(input.chatId),
          stringifyJson(input.payload), botId, input.eventKey)
      } else {
        db.prepare(`
          INSERT INTO feishu_inbound_events
            (bot_id, event_key, event_type, message_id, chat_id, status, attempts,
             payload_json, received_at_iso, lease_expires_at_iso, processed_at_iso, last_error)
          VALUES (?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, NULL, '')
        `).run(botId, input.eventKey, clean(input.eventType), clean(input.messageId), clean(input.chatId),
          stringifyJson(input.payload), timestamp, leaseExpires)
      }
      return normalizeInbound(db.prepare(`${EVENT_SELECT} WHERE bot_id = ? AND event_key = ?`).get(botId, input.eventKey) as Record<string, unknown>)
    })
    return transaction()
  })
}

export async function completeFeishuInboundEvent(eventKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return updateInboundStatus(eventKey, botId, 'processed', '')
}

export async function failFeishuInboundEvent(eventKey: string, error: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  return updateInboundStatus(eventKey, botId, 'failed', error)
}

async function updateInboundStatus(eventKey: string, botId: string, status: 'processed' | 'failed', error: string): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return db.prepare(`UPDATE feishu_inbound_events SET status = ?, lease_expires_at_iso = NULL,
      processed_at_iso = ?, last_error = ? WHERE bot_id = ? AND event_key = ?`)
      .run(status, nowIso(), error, normalizeBotId(botId), eventKey).changes > 0
  })
}

/** Compatibility API: claims once and immediately marks processed. */
export async function claimFeishuEvent(eventKey: string, botId = DEFAULT_FEISHU_BOT_ID): Promise<boolean> {
  const claimed = await claimFeishuInboundEvent({ botId, eventKey })
  if (!claimed) return false
  await completeFeishuInboundEvent(eventKey, botId)
  return true
}

function normalizeOutbox(row: Record<string, unknown>): FeishuOutboxItem {
  return { id: String(row.id), botId: String(row.botId), bindingKey: String(row.bindingKey), kind: String(row.kind),
    targetId: String(row.targetId), payload: parseJson(row.payloadJson),
    dedupeKey: typeof row.dedupeKey === 'string' ? row.dedupeKey : null,
    status: row.status as FeishuOutboxStatus, attempts: Number(row.attempts), availableAtIso: String(row.availableAtIso),
    leaseExpiresAtIso: typeof row.leaseExpiresAtIso === 'string' ? row.leaseExpiresAtIso : null,
    remoteMessageId: typeof row.remoteMessageId === 'string' ? row.remoteMessageId : null,
    lastError: String(row.lastError ?? ''), createdAtIso: String(row.createdAtIso), updatedAtIso: String(row.updatedAtIso),
    sentAtIso: typeof row.sentAtIso === 'string' ? row.sentAtIso : null,
    deadLetteredAtIso: typeof row.deadLetteredAtIso === 'string' ? row.deadLetteredAtIso : null }
}

const OUTBOX_SELECT = `SELECT id, bot_id AS botId, binding_key AS bindingKey, kind, target_id AS targetId,
  payload_json AS payloadJson, dedupe_key AS dedupeKey, status, attempts,
  available_at_iso AS availableAtIso, lease_expires_at_iso AS leaseExpiresAtIso,
  remote_message_id AS remoteMessageId, last_error AS lastError,
  created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso, sent_at_iso AS sentAtIso,
  dead_lettered_at_iso AS deadLetteredAtIso FROM feishu_outbox`

export async function enqueueFeishuOutbox(input: {
  id?: string
  botId?: string
  bindingKey?: string
  kind: string
  targetId: string
  payload: unknown
  dedupeKey?: string | null
  availableAtIso?: string
}): Promise<FeishuOutboxItem> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(input.botId)
    ensureBotExists(db, botId)
    const timestamp = nowIso()
    const id = input.id ?? randomUUID()
    const dedupeKey = clean(input.dedupeKey ?? undefined) || null
    let payload = input.payload
    if (input.kind === 'transport.update_card') {
      const value = asRecordForStore(input.payload) ?? {}
      const requestedVersion = typeof value.cardVersion === 'number' && Number.isFinite(value.cardVersion)
        ? Math.max(0, Math.trunc(value.cardVersion))
        : 0
      const latest = db.prepare(`SELECT MAX(CAST(COALESCE(json_extract(payload_json, '$.cardVersion'), 0) AS INTEGER)) AS version
        FROM feishu_outbox WHERE bot_id = ? AND kind = 'transport.update_card' AND target_id = ?`)
        .get(botId, input.targetId) as { version?: number | null }
      payload = { ...value, cardVersion: Math.max(requestedVersion, Number(latest.version ?? 0) + 1) }
    }
    db.prepare(`
      INSERT INTO feishu_outbox
        (id, bot_id, binding_key, kind, target_id, payload_json, dedupe_key,
         status, attempts, available_at_iso, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(bot_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    `).run(id, botId, clean(input.bindingKey), input.kind, input.targetId, stringifyJson(payload),
      dedupeKey, input.availableAtIso ?? timestamp, timestamp, timestamp)
    const row = dedupeKey
      ? db.prepare(`${OUTBOX_SELECT} WHERE bot_id = ? AND dedupe_key = ?`).get(botId, dedupeKey)
      : db.prepare(`${OUTBOX_SELECT} WHERE id = ?`).get(id)
    return normalizeOutbox(row as Record<string, unknown>)
  })
}

export async function claimFeishuOutbox(input: { botId?: string; limit?: number; leaseMs?: number } = {}): Promise<FeishuOutboxItem[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    const lease = new Date(Date.now() + Math.max(1_000, input.leaseMs ?? 60_000)).toISOString()
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 10)))
    const transaction = db.transaction(() => {
      const botClause = input.botId ? ' AND bot_id = ?' : ''
      const params = input.botId ? [timestamp, timestamp, normalizeBotId(input.botId), limit] : [timestamp, timestamp, limit]
      const rows = db.prepare(`SELECT id FROM feishu_outbox
        WHERE dead_lettered_at_iso IS NULL AND ((status IN ('pending', 'failed') AND available_at_iso <= ?)
          OR (status = 'sending' AND lease_expires_at_iso <= ?))${botClause}
        ORDER BY available_at_iso, created_at_iso LIMIT ?`).all(...params) as { id: string }[]
      const update = db.prepare("UPDATE feishu_outbox SET status = 'sending', attempts = attempts + 1, lease_expires_at_iso = ?, updated_at_iso = ? WHERE id = ?")
      for (const row of rows) update.run(lease, timestamp, row.id)
      if (!rows.length) return []
      const placeholders = rows.map(() => '?').join(',')
      return (db.prepare(`${OUTBOX_SELECT} WHERE id IN (${placeholders}) ORDER BY available_at_iso, created_at_iso`).all(...rows.map((row) => row.id)) as Record<string, unknown>[]).map(normalizeOutbox)
    })
    return transaction()
  })
}

export async function markFeishuOutboxSent(id: string, remoteMessageId?: string | null): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.prepare("UPDATE feishu_outbox SET status = 'sent', remote_message_id = ?, sent_at_iso = ?, lease_expires_at_iso = NULL, last_error = '', updated_at_iso = ? WHERE id = ?")
      .run(remoteMessageId ?? null, timestamp, timestamp, id).changes > 0
  })
}

export async function retryFeishuOutbox(id: string, error: string, availableAtIso = nowIso()): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    return db.prepare("UPDATE feishu_outbox SET status = 'failed', available_at_iso = ?, lease_expires_at_iso = NULL, dead_lettered_at_iso = NULL, last_error = ?, updated_at_iso = ? WHERE id = ?")
      .run(availableAtIso, error, nowIso(), id).changes > 0
  })
}

/** Requeues one failed delivery without allowing its id to cross bot boundaries. */
export async function requeueFailedFeishuOutbox(id: string, botId: string, availableAtIso = nowIso()): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.prepare(`UPDATE feishu_outbox SET status = 'pending', attempts = 0,
      available_at_iso = ?, lease_expires_at_iso = NULL, dead_lettered_at_iso = NULL,
      last_error = '', updated_at_iso = ?
      WHERE id = ? AND bot_id = ? AND status = 'failed'`)
      .run(availableAtIso, timestamp, id, normalizeBotId(botId)).changes > 0
  })
}

export async function deadLetterFeishuOutbox(id: string, error: string): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.prepare("UPDATE feishu_outbox SET status = 'failed', lease_expires_at_iso = NULL, dead_lettered_at_iso = ?, last_error = ?, updated_at_iso = ? WHERE id = ?")
      .run(timestamp, error, timestamp, id).changes > 0
  })
}

export async function supersedeFeishuCardUpdates(input: {
  botId: string; targetId: string; keepId: string; cardVersion: number
}): Promise<string[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const timestamp = nowIso()
    return db.transaction(() => {
      const params = [normalizeBotId(input.botId), input.targetId, input.keepId, input.cardVersion] as const
      const ids = db.prepare(`SELECT id FROM feishu_outbox
        WHERE bot_id = ? AND kind = 'transport.update_card' AND target_id = ? AND id != ?
          AND status IN ('pending', 'failed') AND dead_lettered_at_iso IS NULL
          AND CAST(COALESCE(json_extract(payload_json, '$.cardVersion'), 0) AS INTEGER) < ?`)
        .all(...params) as Array<{ id: string }>
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        db.prepare(`UPDATE feishu_outbox SET status = 'sent', sent_at_iso = ?, lease_expires_at_iso = NULL,
          last_error = 'superseded by newer card version', updated_at_iso = ? WHERE id IN (${placeholders})`)
          .run(timestamp, timestamp, ...ids.map((row) => row.id))
      }
      return ids.map((row) => row.id)
    })()
  })
}

export async function isFeishuCardUpdateCurrent(item: Pick<FeishuOutboxItem, 'id' | 'botId' | 'targetId' | 'payload'>): Promise<boolean> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const payload = asRecordForStore(item.payload)
    const version = typeof payload?.cardVersion === 'number' ? payload.cardVersion : 0
    const newer = db.prepare(`SELECT 1 FROM feishu_outbox
      WHERE bot_id = ? AND kind = 'transport.update_card' AND target_id = ? AND id != ?
        AND dead_lettered_at_iso IS NULL
        AND CAST(COALESCE(json_extract(payload_json, '$.cardVersion'), 0) AS INTEGER) > ?
      LIMIT 1`).get(normalizeBotId(item.botId), item.targetId, item.id, version)
    return !newer
  })
}

function asRecordForStore(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function listFeishuOutbox(filter: { botId?: string; status?: FeishuOutboxStatus; limit?: number } = {}): Promise<FeishuOutboxItem[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.botId) { clauses.push('bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status) }
    params.push(Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 100))))
    return (db.prepare(`${OUTBOX_SELECT}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at_iso DESC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(normalizeOutbox)
  })
}

function normalizeTurn(row: Record<string, unknown>): FeishuTurn {
  return { id: String(row.id), botId: String(row.botId), bindingKey: String(row.bindingKey),
    inboundMessageId: String(row.inboundMessageId), sessionId: String(row.sessionId), turnId: String(row.turnId),
    status: row.status as FeishuTurnStatus, prompt: String(row.prompt), responseText: String(row.responseText),
    cardId: typeof row.cardId === 'string' ? row.cardId : null, lastError: String(row.lastError),
    createdAtIso: String(row.createdAtIso), updatedAtIso: String(row.updatedAtIso),
    completedAtIso: typeof row.completedAtIso === 'string' ? row.completedAtIso : null }
}

const TURN_SELECT = `SELECT id, bot_id AS botId, binding_key AS bindingKey,
  inbound_message_id AS inboundMessageId, session_id AS sessionId, turn_id AS turnId,
  status, prompt, response_text AS responseText, card_id AS cardId, last_error AS lastError,
  created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso, completed_at_iso AS completedAtIso FROM feishu_turns`

export async function createFeishuTurn(input: {
  id?: string; botId?: string; bindingKey: string; inboundMessageId?: string
  sessionId: string; turnId?: string; prompt?: string; status?: FeishuTurnStatus
}): Promise<FeishuTurn> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(input.botId)
    ensureBotExists(db, botId)
    const timestamp = nowIso()
    const id = input.id ?? randomUUID()
    db.prepare(`INSERT INTO feishu_turns
      (id, bot_id, binding_key, inbound_message_id, session_id, turn_id, status,
       prompt, response_text, last_error, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
      ON CONFLICT(bot_id, inbound_message_id) WHERE inbound_message_id <> '' DO NOTHING`)
      .run(id, botId, input.bindingKey, clean(input.inboundMessageId), input.sessionId,
        clean(input.turnId), input.status ?? 'queued', input.prompt ?? '', timestamp, timestamp)
    const row = input.inboundMessageId
      ? db.prepare(`${TURN_SELECT} WHERE bot_id = ? AND inbound_message_id = ?`).get(botId, input.inboundMessageId)
      : db.prepare(`${TURN_SELECT} WHERE id = ?`).get(id)
    return normalizeTurn(row as Record<string, unknown>)
  })
}

export async function updateFeishuTurn(id: string, patch: Partial<Pick<FeishuTurn, 'turnId' | 'status' | 'responseText' | 'cardId' | 'lastError' | 'completedAtIso'>>): Promise<FeishuTurn | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const current = db.prepare(`${TURN_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (!current) return null
    const value = normalizeTurn(current)
    if (['completed', 'failed', 'cancelled'].includes(value.status)
      && patch.status !== undefined
      && !['completed', 'failed', 'cancelled'].includes(patch.status)) return value
    const status = patch.status ?? value.status
    const completedAtIso = patch.completedAtIso !== undefined ? patch.completedAtIso
      : ['completed', 'failed', 'cancelled'].includes(status) ? nowIso() : value.completedAtIso
    db.prepare(`UPDATE feishu_turns SET turn_id = ?, status = ?, response_text = ?, card_id = ?,
      last_error = ?, completed_at_iso = ?, updated_at_iso = ? WHERE id = ?`)
      .run(patch.turnId ?? value.turnId, status, patch.responseText ?? value.responseText,
        patch.cardId === undefined ? value.cardId : patch.cardId, patch.lastError ?? value.lastError,
        completedAtIso, nowIso(), id)
    return normalizeTurn(db.prepare(`${TURN_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>)
  })
}

export async function findFeishuTurn(id: string): Promise<FeishuTurn | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const row = db.prepare(`${TURN_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? normalizeTurn(row) : null
  })
}

export async function listFeishuTurns(filter: { botId?: string; sessionId?: string; bindingKey?: string; limit?: number } = {}): Promise<FeishuTurn[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.botId) { clauses.push('bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    if (filter.sessionId) { clauses.push('session_id = ?'); params.push(filter.sessionId) }
    if (filter.bindingKey) { clauses.push('binding_key = ?'); params.push(filter.bindingKey) }
    params.push(Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 100))))
    return (db.prepare(`${TURN_SELECT}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at_iso DESC, rowid DESC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(normalizeTurn)
  })
}

function normalizeCard(row: Record<string, unknown>): FeishuCard {
  return { id: String(row.id), botId: String(row.botId), bindingKey: String(row.bindingKey),
    messageId: typeof row.messageId === 'string' ? row.messageId : null, purpose: String(row.purpose),
    status: row.status as FeishuCardStatus, version: Number(row.version), state: parseJson(row.stateJson),
    createdAtIso: String(row.createdAtIso), updatedAtIso: String(row.updatedAtIso) }
}

const CARD_SELECT = `SELECT id, bot_id AS botId, binding_key AS bindingKey, message_id AS messageId,
  purpose, status, version, state_json AS stateJson, created_at_iso AS createdAtIso,
  updated_at_iso AS updatedAtIso FROM feishu_cards`

export async function upsertFeishuCard(input: {
  id: string; botId?: string; bindingKey?: string; messageId?: string | null
  purpose: string; status: FeishuCardStatus; version?: number; state?: unknown
}): Promise<FeishuCard> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const botId = normalizeBotId(input.botId)
    ensureBotExists(db, botId)
    const timestamp = nowIso()
    db.prepare(`INSERT INTO feishu_cards
      (id, bot_id, binding_key, message_id, purpose, status, version, state_json, created_at_iso, updated_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET message_id = excluded.message_id, status = excluded.status,
        version = excluded.version, state_json = excluded.state_json, updated_at_iso = excluded.updated_at_iso
      WHERE excluded.version >= feishu_cards.version
        AND (feishu_cards.status NOT IN ('completed', 'failed', 'cancelled')
          OR excluded.status IN ('completed', 'failed', 'cancelled'))`)
      .run(input.id, botId, clean(input.bindingKey), input.messageId ?? null, input.purpose, input.status,
        input.version ?? 0, stringifyJson(input.state), timestamp, timestamp)
    return normalizeCard(db.prepare(`${CARD_SELECT} WHERE id = ?`).get(input.id) as Record<string, unknown>)
  })
}

export async function findFeishuCard(id: string): Promise<FeishuCard | null> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const row = db.prepare(`${CARD_SELECT} WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row ? normalizeCard(row) : null
  })
}

export async function listFeishuCards(filter: { botId?: string; bindingKey?: string; limit?: number } = {}): Promise<FeishuCard[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.botId) { clauses.push('bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    if (filter.bindingKey) { clauses.push('binding_key = ?'); params.push(filter.bindingKey) }
    params.push(Math.min(500, Math.max(1, Math.trunc(filter.limit ?? 100))))
    return (db.prepare(`${CARD_SELECT}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at_iso DESC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(normalizeCard)
  })
}

function normalizeAudit(row: Record<string, unknown>): FeishuAuditLog {
  return { id: String(row.id), botId: String(row.botId), actorOpenId: String(row.actorOpenId),
    action: String(row.action), targetType: String(row.targetType), targetId: String(row.targetId),
    success: row.success === 1, metadata: parseJson(row.metadataJson), error: String(row.error),
    createdAtIso: String(row.createdAtIso) }
}

const AUDIT_SELECT = `SELECT id, bot_id AS botId, actor_open_id AS actorOpenId, action,
  target_type AS targetType, target_id AS targetId, success, metadata_json AS metadataJson,
  error, created_at_iso AS createdAtIso FROM feishu_audit_logs`

export async function appendFeishuAuditLog(input: {
  id?: string; botId?: string; actorOpenId?: string; action: string; targetType?: string
  targetId?: string; success?: boolean; metadata?: unknown; error?: string; createdAtIso?: string
}): Promise<FeishuAuditLog> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const id = input.id ?? randomUUID()
    db.prepare(`INSERT INTO feishu_audit_logs
      (id, bot_id, actor_open_id, action, target_type, target_id, success, metadata_json, error, created_at_iso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, normalizeBotId(input.botId), clean(input.actorOpenId), input.action, clean(input.targetType),
        clean(input.targetId), input.success === false ? 0 : 1, stringifyJson(input.metadata),
        input.error ?? '', input.createdAtIso ?? nowIso())
    return normalizeAudit(db.prepare(`${AUDIT_SELECT} WHERE id = ?`).get(id) as Record<string, unknown>)
  })
}

export async function listFeishuAuditLogs(filter: { botId?: string; action?: string; limit?: number } = {}): Promise<FeishuAuditLog[]> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.botId) { clauses.push('bot_id = ?'); params.push(normalizeBotId(filter.botId)) }
    if (filter.action) { clauses.push('action = ?'); params.push(filter.action) }
    params.push(Math.min(1_000, Math.max(1, Math.trunc(filter.limit ?? 100))))
    return (db.prepare(`${AUDIT_SELECT}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at_iso DESC LIMIT ?`).all(...params) as Record<string, unknown>[]).map(normalizeAudit)
  })
}

function retentionMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName]?.trim()
  if (!raw) return defaultMs
  const days = Number(raw)
  return Number.isFinite(days) && days >= 0 ? days * 24 * 60 * 60_000 : defaultMs
}

export type FeishuCleanupResult = {
  pendingMessages: number
  inboundEvents: number
  sentOutbox: number
  deadLetters: number
  turns: number
  cards: number
  auditLogs: number
}

/** Removes terminal operational history without touching active/queued/sending work. */
export async function cleanupFeishuOperationalData(now = new Date()): Promise<FeishuCleanupResult> {
  return withLocalDatabase((db) => {
    ensureFeishuTables(db)
    const cutoff = (envName: string, defaultMs: number) => new Date(now.getTime() - retentionMs(envName, defaultMs)).toISOString()
    const pendingCutoff = cutoff('CODY_FEISHU_PENDING_RETENTION_DAYS', 24 * 60 * 60_000)
    const inboundCutoff = cutoff('CODY_FEISHU_INBOUND_RETENTION_DAYS', 7 * 24 * 60 * 60_000)
    const terminalCutoff = cutoff('CODY_FEISHU_TERMINAL_RETENTION_DAYS', 30 * 24 * 60 * 60_000)
    const auditCutoff = cutoff('CODY_FEISHU_AUDIT_RETENTION_DAYS', 90 * 24 * 60 * 60_000)
    const deadCutoff = cutoff('CODY_FEISHU_DEAD_LETTER_RETENTION_DAYS', 90 * 24 * 60 * 60_000)
    return db.transaction(() => ({
      pendingMessages: db.prepare('DELETE FROM feishu_pending_messages_v2 WHERE created_at_iso < ?').run(pendingCutoff).changes,
      inboundEvents: db.prepare("DELETE FROM feishu_inbound_events WHERE status != 'processing' AND received_at_iso < ?").run(inboundCutoff).changes,
      sentOutbox: db.prepare("DELETE FROM feishu_outbox WHERE status = 'sent' AND sent_at_iso < ?").run(terminalCutoff).changes,
      deadLetters: db.prepare('DELETE FROM feishu_outbox WHERE dead_lettered_at_iso IS NOT NULL AND dead_lettered_at_iso < ?').run(deadCutoff).changes,
      turns: db.prepare("DELETE FROM feishu_turns WHERE status IN ('completed', 'failed', 'cancelled') AND COALESCE(completed_at_iso, updated_at_iso) < ?").run(terminalCutoff).changes,
      cards: db.prepare("DELETE FROM feishu_cards WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at_iso < ?").run(terminalCutoff).changes,
      auditLogs: db.prepare('DELETE FROM feishu_audit_logs WHERE created_at_iso < ?').run(auditCutoff).changes,
    }))()
  })
}
