/**
 * Preload script: exposes a typed `window.api` to the renderer that
 * forwards calls to the main process via IPC.
 *
 * Renderer never imports anything from /main — only via this bridge.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels.js';
import type {
  ApiKeyStatus,
  AppState,
  AudioDevice,
  CalendarLeadMinutes,
  CalendarStatus,
  ChatChunkEvent,
  ChatImagePart,
  ChatPdfPart,
  ChatScope,
  ChatSession,
  DoctorCheck,
  MeetingDetail,
  MeetingMeta,
  ModelInfo,
  ProcessingUpdate,
  ProjectMeta,
  ProjectWithStats,
  RecordingState,
  SourceEntry,
  StartRecordingArgs,
  TeamMeta,
  TeamWithStats,
} from '../shared/types.js';

interface ListMeetingsOpts {
  team?: string;
  project?: string;
  includeUnfiled?: boolean;
}

const api = {
  meetings: {
    list: (opts?: ListMeetingsOpts): Promise<MeetingMeta[]> =>
      ipcRenderer.invoke(IPC.Meetings.List, opts),
    get: (dir: string): Promise<MeetingDetail> =>
      ipcRenderer.invoke(IPC.Meetings.Get, dir),
    saveNotes: (dir: string, notes: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Meetings.SaveNotes, dir, notes),
    delete: (dir: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Meetings.Delete, dir),
    deleteRecording: (dir: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Meetings.DeleteRecording, dir),
    resummarize: (dir: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Meetings.Resummarize, dir),
    move: (dir: string, toTeam: string, toProject: string): Promise<string> =>
      ipcRenderer.invoke(IPC.Meetings.Move, dir, toTeam, toProject),
    rename: (dir: string, newTitle: string): Promise<MeetingMeta> =>
      ipcRenderer.invoke(IPC.Meetings.Rename, dir, newTitle),
    attachScreenshot: (
      dir: string,
      dataUrl: string,
      meta?: { atMs?: number | null; observation?: string },
    ): Promise<string> =>
      ipcRenderer.invoke(IPC.Meetings.AttachScreenshot, dir, dataUrl, meta),
    readAttachment: (dir: string, relPath: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.Meetings.ReadAttachment, dir, relPath),
  },
  teams: {
    list: (): Promise<TeamMeta[]> => ipcRenderer.invoke(IPC.Teams.List),
    get: (slug: string): Promise<TeamMeta | null> => ipcRenderer.invoke(IPC.Teams.Get, slug),
    listWithStats: (): Promise<TeamWithStats[]> => ipcRenderer.invoke(IPC.Teams.ListWithStats),
    create: (slug: string, name: string, description?: string): Promise<TeamMeta> =>
      ipcRenderer.invoke(IPC.Teams.Create, slug, name, description),
  },
  projects: {
    list: (teamSlug: string): Promise<ProjectMeta[]> =>
      ipcRenderer.invoke(IPC.Projects.List, teamSlug),
    listWithStats: (teamSlug: string): Promise<ProjectWithStats[]> =>
      ipcRenderer.invoke(IPC.Projects.ListWithStats, teamSlug),
    create: (
      teamSlug: string,
      slug: string,
      name: string,
      description?: string,
    ): Promise<ProjectMeta> =>
      ipcRenderer.invoke(IPC.Projects.Create, teamSlug, slug, name, description),
  },
  chat: {
    read: (scope: ChatScope): Promise<ChatSession> => ipcRenderer.invoke(IPC.Chat.Read, scope),
    send: (args: {
      scope: ChatScope;
      text: string;
      images?: ChatImagePart[];
      pdfs?: ChatPdfPart[];
      model: string;
      excludedSourceIds?: string[];
      excludedMeetingSlugs?: string[];
    }): Promise<string> => ipcRenderer.invoke(IPC.Chat.Send, args),
    clear: (scope: ChatScope): Promise<void> => ipcRenderer.invoke(IPC.Chat.Clear, scope),
  },
  models: {
    list: (): Promise<ModelInfo[]> => ipcRenderer.invoke(IPC.Models.List),
  },
  exportBundle: {
    /** Build + save a context-export zip for the given scope. Resolves to
     *  the file path the user chose, or `null` if they cancelled. */
    save: (scope: ChatScope): Promise<string | null> =>
      ipcRenderer.invoke(IPC.Export.Bundle, { scope }),
  },
  sources: {
    list: (team: string, project: string): Promise<SourceEntry[]> =>
      ipcRenderer.invoke(IPC.Sources.List, team, project),
    add: (args: {
      team: string;
      project: string;
      filename: string;
      dataUrl: string;
      mimeType?: string;
      observation?: string;
    }): Promise<SourceEntry> => ipcRenderer.invoke(IPC.Sources.Add, args),
    remove: (team: string, project: string, id: string): Promise<void> =>
      ipcRenderer.invoke(IPC.Sources.Remove, team, project, id),
    read: (team: string, project: string, id: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.Sources.Read, team, project, id),
  },
  recording: {
    start: (args: StartRecordingArgs): Promise<{ slug: string; dir: string }> =>
      ipcRenderer.invoke(IPC.Recording.Start, args),
    stop: (): Promise<{
      dir: string;
      slug: string;
      title: string;
      team: string;
      project: string;
    }> => ipcRenderer.invoke(IPC.Recording.Stop),
    commitStop: (args: {
      dir: string;
      title: string;
      team: string;
      project: string;
    }): Promise<{ dir: string }> => ipcRenderer.invoke(IPC.Recording.CommitStop, args),
    getState: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.Recording.GetState),
  },
  appState: {
    get: (): Promise<AppState> => ipcRenderer.invoke(IPC.AppState.Get),
    set: (patch: Partial<AppState>): Promise<AppState> => ipcRenderer.invoke(IPC.AppState.Set, patch),
  },
  audio: {
    listDevices: (): Promise<AudioDevice[]> => ipcRenderer.invoke(IPC.Audio.ListDevices),
    getDevice: (): Promise<string> => ipcRenderer.invoke(IPC.Audio.GetDevice),
    /** Persist the chosen device (e.g. ":2"), or null to reset. Returns the
     *  resolved device now in effect. */
    setDevice: (device: string | null): Promise<string> =>
      ipcRenderer.invoke(IPC.Audio.SetDevice, device),
  },
  diagnostics: {
    doctor: (): Promise<DoctorCheck[]> => ipcRenderer.invoke(IPC.Diagnostics.Doctor),
  },
  settings: {
    getApiKeyStatus: (): Promise<ApiKeyStatus> =>
      ipcRenderer.invoke(IPC.Settings.GetApiKeyStatus),
    /** Save the Claude API key (encrypted in the main process). Empty clears it. */
    setApiKey: (key: string): Promise<ApiKeyStatus> =>
      ipcRenderer.invoke(IPC.Settings.SetApiKey, key),
  },
  calendar: {
    status: (): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.Status),
    setClient: (args: {
      clientId: string;
      clientSecret: string;
    }): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.SetClient, args),
    connect: (): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.Connect),
    disconnect: (): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.Disconnect),
    updateSettings: (patch: {
      enabled?: boolean;
      leadMinutes?: CalendarLeadMinutes;
    }): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.UpdateSettings, patch),
    pollNow: (): Promise<CalendarStatus> => ipcRenderer.invoke(IPC.Calendar.Poll),
  },
  /** Subscribe to processing-stage events from main. Returns an unsubscriber. */
  onProcessingUpdate: (cb: (update: ProcessingUpdate) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, update: ProcessingUpdate): void => cb(update);
    ipcRenderer.on(IPC.Events.ProcessingUpdate, handler);
    return () => ipcRenderer.removeListener(IPC.Events.ProcessingUpdate, handler);
  },
  /** Subscribe to "open start recording dialog" requests from main (e.g. tray click). */
  onOpenStartRecording: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.Events.OpenStartRecording, handler);
    return () => ipcRenderer.removeListener(IPC.Events.OpenStartRecording, handler);
  },
  /** Subscribe to "open settings" requests from main. */
  onOpenSettings: (cb: () => void): (() => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(IPC.Events.OpenSettings, handler);
    return () => ipcRenderer.removeListener(IPC.Events.OpenSettings, handler);
  },
  /** Subscribe to streaming chat chunks from in-flight requests. */
  onChatChunk: (cb: (event: ChatChunkEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: ChatChunkEvent): void => cb(event);
    ipcRenderer.on(IPC.Events.ChatChunk, handler);
    return () => ipcRenderer.removeListener(IPC.Events.ChatChunk, handler);
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
