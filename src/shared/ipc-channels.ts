/**
 * Channel names for IPC between Electron main and renderer.
 *
 * Kept as a single source of truth in /shared so both sides import the same
 * strings and you can't accidentally drift them apart.
 */

export const IPC = {
  Meetings: {
    List: 'meetings:list',
    Get: 'meetings:get',
    SaveNotes: 'meetings:saveNotes',
    Delete: 'meetings:delete',
    DeleteRecording: 'meetings:deleteRecording',
    Resummarize: 'meetings:resummarize',
    Move: 'meetings:move',
    Rename: 'meetings:rename',
    AttachScreenshot: 'meetings:attachScreenshot',
    ReadAttachment: 'meetings:readAttachment',
  },
  Teams: {
    List: 'teams:list',
    ListWithStats: 'teams:listWithStats',
    Get: 'teams:get',
    Create: 'teams:create',
  },
  Projects: {
    List: 'projects:list',
    ListWithStats: 'projects:listWithStats',
    Create: 'projects:create',
  },
  Sources: {
    List: 'sources:list',
    Add: 'sources:add',
    Remove: 'sources:remove',
    Read: 'sources:read',
  },
  Chat: {
    Read: 'chat:read',
    Send: 'chat:send',
    Clear: 'chat:clear',
  },
  Models: {
    List: 'models:list',
  },
  Export: {
    /** Build a context-export zip for a chat scope (project or meeting) and
     *  prompt the user via a Save dialog. Resolves with the saved path, or
     *  `null` if the user cancelled. */
    Bundle: 'export:bundle',
  },
  Calendar: {
    /** Read the current calendar status (connected? settings? last sync?). */
    Status: 'calendar:status',
    /** Set/replace the Google OAuth client (client_id + client_secret). */
    SetClient: 'calendar:setClient',
    /** Run the OAuth dance and persist tokens. */
    Connect: 'calendar:connect',
    /** Forget tokens + account info; turn the poller off. */
    Disconnect: 'calendar:disconnect',
    /** Patch user-facing settings (enabled, leadMinutes). */
    UpdateSettings: 'calendar:updateSettings',
    /** Manually trigger a poll right now (debug / UX nicety). */
    Poll: 'calendar:poll',
  },
  AppState: {
    Get: 'appState:get',
    Set: 'appState:set',
  },
  Recording: {
    Start: 'recording:start',
    Stop: 'recording:stop',
    CommitStop: 'recording:commitStop',
    GetState: 'recording:getState',
  },
  Audio: {
    ListDevices: 'audio:listDevices',
    GetDevice: 'audio:getDevice',
    SetDevice: 'audio:setDevice',
  },
  Diagnostics: {
    Doctor: 'diagnostics:doctor',
  },
  Settings: {
    /** Read the Claude API key status (source + masked hint) — never the raw key. */
    GetApiKeyStatus: 'settings:getApiKeyStatus',
    /** Save the Claude API key (encrypted). Pass an empty string to clear it. */
    SetApiKey: 'settings:setApiKey',
  },
  Events: {
    ProcessingUpdate: 'event:processingUpdate',
    /** Main → renderer: open the "Start recording" dialog (e.g. from the tray menu). */
    OpenStartRecording: 'event:openStartRecording',
    /** Main → renderer: open the settings panel. */
    OpenSettings: 'event:openSettings',
    /** Main → renderer: a streaming chat chunk for an in-flight request. */
    ChatChunk: 'event:chatChunk',
  },
} as const;
