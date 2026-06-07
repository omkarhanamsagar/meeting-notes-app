import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatScope, ModelInfo } from '../../shared/types';
import { ChatView } from './ChatView';
import { SourcesTabContent } from './SourcesTabContent';

type Tab = 'chat' | 'sources';
type Width = 'collapsed' | 'normal' | 'wide';

function exclusionKey(kind: 'sources' | 'meetings', team: string, project: string): string {
  return `projectSideRail.exclude.${kind}.${team}:${project}`;
}

function loadExclusions(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    // ignore
  }
  return new Set();
}

function saveExclusions(key: string, value: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(value)));
  } catch {
    // ignore
  }
}

interface ProjectSideRailProps {
  team: string;
  project: string;
  models: ModelInfo[];
  defaultModel: string;
}

const WIDTH_KEY = 'projectSideRail.width';
const TAB_KEY = 'projectSideRail.tab';

function loadWidth(): Width {
  try {
    const v = localStorage.getItem(WIDTH_KEY);
    if (v === 'collapsed' || v === 'normal' || v === 'wide') return v;
  } catch {
    // ignore
  }
  return 'normal';
}

function saveWidth(w: Width): void {
  try {
    localStorage.setItem(WIDTH_KEY, w);
  } catch {
    // ignore
  }
}

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    if (v === 'chat' || v === 'sources') return v;
  } catch {
    // ignore
  }
  return 'chat';
}

function saveTab(t: Tab): void {
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    // ignore
  }
}

export function ProjectSideRail({
  team,
  project,
  models,
  defaultModel,
}: ProjectSideRailProps) {
  const [width, setWidth] = useState<Width>(loadWidth);
  const [tab, setTab] = useState<Tab>(loadTab);

  const sourcesKey = exclusionKey('sources', team, project);
  const meetingsKey = exclusionKey('meetings', team, project);
  const [excludedSourceIds, setExcludedSourceIdsState] = useState<Set<string>>(() =>
    loadExclusions(sourcesKey),
  );
  const [excludedMeetingSlugs, setExcludedMeetingSlugsState] = useState<Set<string>>(() =>
    loadExclusions(meetingsKey),
  );

  // Re-load exclusions whenever the project changes.
  useEffect(() => {
    setExcludedSourceIdsState(loadExclusions(sourcesKey));
    setExcludedMeetingSlugsState(loadExclusions(meetingsKey));
  }, [sourcesKey, meetingsKey]);

  useEffect(() => {
    saveWidth(width);
  }, [width]);

  useEffect(() => {
    saveTab(tab);
  }, [tab]);

  useEffect(() => {
    saveExclusions(sourcesKey, excludedSourceIds);
  }, [sourcesKey, excludedSourceIds]);

  useEffect(() => {
    saveExclusions(meetingsKey, excludedMeetingSlugs);
  }, [meetingsKey, excludedMeetingSlugs]);

  const setExcludedSourceIds = useCallback((next: Set<string>) => {
    setExcludedSourceIdsState(new Set(next));
  }, []);
  const setExcludedMeetingSlugs = useCallback((next: Set<string>) => {
    setExcludedMeetingSlugsState(new Set(next));
  }, []);
  const toggleSource = useCallback((id: string) => {
    setExcludedSourceIdsState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleMeeting = useCallback((slug: string) => {
    setExcludedMeetingSlugsState((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }, []);

  const excludedSourceIdsArr = useMemo(() => Array.from(excludedSourceIds), [excludedSourceIds]);
  const excludedMeetingSlugsArr = useMemo(() => Array.from(excludedMeetingSlugs), [excludedMeetingSlugs]);

  const chatScope: ChatScope = { kind: 'project', team, project };

  if (width === 'collapsed') {
    return (
      <aside className="side-rail side-rail--collapsed">
        <button
          className="side-rail-collapsed-btn"
          onClick={() => setWidth('normal')}
          title="Show panel"
          aria-label="Show panel"
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <>
      {width === 'wide' && (
        <div
          className="side-rail-backdrop"
          onClick={() => setWidth('normal')}
          aria-hidden
        />
      )}
      <aside className={`side-rail side-rail--${width}`}>
      <div className="side-rail-header">
        <button
          className="side-rail-icon-btn"
          onClick={() => setWidth('collapsed')}
          title="Hide panel"
          aria-label="Hide panel"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="side-rail-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'chat'}
            className={`side-rail-tab${tab === 'chat' ? ' is-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            Chat
          </button>
          <button
            role="tab"
            aria-selected={tab === 'sources'}
            className={`side-rail-tab${tab === 'sources' ? ' is-active' : ''}`}
            onClick={() => setTab('sources')}
          >
            Sources
          </button>
        </div>
        <button
          className="side-rail-icon-btn"
          onClick={() => setWidth(width === 'wide' ? 'normal' : 'wide')}
          title={width === 'wide' ? 'Shrink panel' : 'Expand panel'}
          aria-label={width === 'wide' ? 'Shrink panel' : 'Expand panel'}
        >
          {width === 'wide' ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>

      <div className="side-rail-body">
        {tab === 'chat' ? (
          <ChatView
            scope={chatScope}
            models={models}
            defaultModel={defaultModel}
            className="chat-view--in-rail"
            excludedSourceIds={excludedSourceIdsArr}
            excludedMeetingSlugs={excludedMeetingSlugsArr}
          />
        ) : (
          <SourcesTabContent
            team={team}
            project={project}
            excludedSourceIds={excludedSourceIds}
            excludedMeetingSlugs={excludedMeetingSlugs}
            toggleSource={toggleSource}
            toggleMeeting={toggleMeeting}
            setExcludedSourceIds={setExcludedSourceIds}
            setExcludedMeetingSlugs={setExcludedMeetingSlugs}
          />
        )}
      </div>
    </aside>
    </>
  );
}
