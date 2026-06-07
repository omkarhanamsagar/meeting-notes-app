import { useEffect, useRef, useState } from 'react';

interface NotesEditorProps {
  /** Absolute path to the meeting directory. Used as the base for resolving
   *  `attachments/*.png` references and as the target for save / attach IPC. */
  dir: string;
  /** Initial markdown content (e.g. notes.md) */
  initialValue: string;
  /** Placeholder shown when the editor is empty. */
  placeholder?: string;
  /** Called with the latest markdown after a debounced interval. */
  onSave: (markdown: string) => void;
  /** Optional class hook for variant styling (canvas vs. detail-tab). */
  className?: string;
  /** Epoch ms when the live recording started. If set, every dropped
   *  screenshot is tagged with `Date.now() - recordingStartedAt` so the
   *  summarizer can match it to the transcript window. `null` in the
   *  post-meeting Notes tab. */
  recordingStartedAt?: number | null;
}

const SAVE_DEBOUNCE_MS = 600;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Rich notes editor that persists as plain markdown but renders inline
 * images while editing. Used both by the live recording canvas and the
 * Notes tab on a finished meeting.
 *
 * Implementation:
 *   - The editing surface is a contenteditable div.
 *   - On load we parse the markdown looking for `![alt](path)` patterns
 *     and insert real <img> elements; everything else stays as text +
 *     <br> nodes.
 *   - On every input/insert we walk the DOM and serialize it back to
 *     markdown (text → text, <img data-attachment> → ![](...), <br> → \n).
 *   - Images are loaded via an IPC `meetings.readAttachment` that returns
 *     a base64 data URL. This sidesteps Chromium's restrictions on
 *     `file://` URLs from the dev origin and works identically in
 *     packaged builds.
 */
export function NotesEditor({
  dir,
  initialValue,
  placeholder,
  onSave,
  className,
  recordingStartedAt,
}: NotesEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestMd = useRef<string>(initialValue);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Resolve a relative attachment path to a data URL via main.
  const loadAttachmentSrc = async (relPath: string): Promise<string | null> => {
    try {
      return await window.api.meetings.readAttachment(dir, relPath);
    } catch (err) {
      console.warn('readAttachment failed for', relPath, err);
      return null;
    }
  };

  // Create an <img> element for a given relative path. The src is filled
  // asynchronously; while loading it shows a transparent placeholder so
  // layout stays stable.
  const buildImage = (relPath: string, alt: string): HTMLImageElement => {
    const img = document.createElement('img');
    img.alt = alt;
    img.className = 'notes-image';
    img.contentEditable = 'false';
    img.setAttribute('data-attachment', relPath);
    img.setAttribute('data-alt', alt);
    // Use a small empty data URL so the image element is visible/laid out
    // immediately, then swap in the real bytes when ready.
    img.src =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"></svg>',
      );
    void loadAttachmentSrc(relPath).then((src) => {
      if (src) img.src = src;
      else img.alt = `Missing attachment: ${relPath}`;
    });
    return img;
  };

  // Paint markdown into the editor on mount / when `initialValue` changes.
  const renderMarkdown = (md: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = '';
    let lastIndex = 0;
    IMAGE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_RE.exec(md)) !== null) {
      const before = md.slice(lastIndex, match.index);
      if (before) appendTextWithBreaks(el, before);
      el.appendChild(buildImage(match[2]!, match[1] ?? 'screenshot'));
      lastIndex = match.index + match[0].length;
    }
    const tail = md.slice(lastIndex);
    if (tail) appendTextWithBreaks(el, tail);
  };

  const serializeToMarkdown = (el: HTMLElement): string => {
    let out = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue ?? '';
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const e = node as HTMLElement;
      const tag = e.tagName.toLowerCase();

      if (tag === 'img') {
        const rel = e.getAttribute('data-attachment');
        const alt = e.getAttribute('data-alt') ?? e.getAttribute('alt') ?? 'screenshot';
        if (rel) {
          if (out.length > 0 && !out.endsWith('\n')) out += '\n';
          out += `![${alt}](${rel})\n`;
        }
        return;
      }
      if (tag === 'br') {
        out += '\n';
        return;
      }
      const isBlock = tag === 'div' || tag === 'p';
      if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';
      for (const child of Array.from(e.childNodes)) walk(child);
      if (isBlock && !out.endsWith('\n')) out += '\n';
    };
    for (const child of Array.from(el.childNodes)) walk(child);
    return out.replace(/\n{3,}/g, '\n\n');
  };

  useEffect(() => {
    latestMd.current = initialValue;
    renderMarkdown(initialValue);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, initialValue]);

  // Debounced save.
  const scheduleSave = (md: string) => {
    latestMd.current = md;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onSave(md);
      setSavedAt(Date.now());
    }, SAVE_DEBOUNCE_MS);
  };

  // Flush on unmount so we never lose in-flight text.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      onSave(latestMd.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  function handleInput() {
    if (!editorRef.current) return;
    scheduleSave(serializeToMarkdown(editorRef.current));
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function insertImage(file: Blob) {
    if (!file.type.startsWith('image/')) return;
    const el = editorRef.current;
    if (!el) return;
    try {
      const dataUrl = await readAsDataUrl(file);

      // Capture context for the multimodal summarizer.
      const atMs =
        typeof recordingStartedAt === 'number'
          ? Math.max(0, Date.now() - recordingStartedAt)
          : null;
      const observation = collectPrecedingObservation(el);

      const relPath = await window.api.meetings.attachScreenshot(dir, dataUrl, {
        atMs,
        observation,
      });

      const img = document.createElement('img');
      img.alt = 'screenshot';
      img.className = 'notes-image';
      img.contentEditable = 'false';
      img.setAttribute('data-attachment', relPath);
      img.setAttribute('data-alt', 'screenshot');
      // Embed the user's image as a data URL right away so it renders
      // without a roundtrip — the saved markdown still references
      // the file on disk.
      img.src = dataUrl;

      const beforeBr = document.createElement('br');
      const afterBr = document.createElement('br');

      const sel = window.getSelection();
      let inserted = false;
      if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const frag = document.createDocumentFragment();
        frag.appendChild(beforeBr);
        frag.appendChild(img);
        frag.appendChild(afterBr);
        range.insertNode(frag);
        range.setStartAfter(afterBr);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        inserted = true;
      }
      if (!inserted) {
        el.appendChild(beforeBr);
        el.appendChild(img);
        el.appendChild(afterBr);
      }

      el.focus();
      handleInput();
    } catch (err) {
      console.error('Failed to attach screenshot', err);
    }
  }

  const [dragActive, setDragActive] = useState(false);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    for (const f of files) void insertImage(f);
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) {
      e.preventDefault();
      setDragActive(true);
    }
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    if (e.currentTarget === e.target) setDragActive(false);
  }
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = Array.from(e.clipboardData.items);
    const imgItem = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (imgItem) {
      const file = imgItem.getAsFile();
      if (file) {
        e.preventDefault();
        void insertImage(file);
        return;
      }
    }
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      document.execCommand('insertText', false, text);
    }
  }

  return (
    <div
      className={`notes-editor-wrap${dragActive ? ' drag-active' : ''}${className ? ' ' + className : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div
        ref={editorRef}
        className="notes-editor-surface"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onPaste={handlePaste}
        data-placeholder={
          placeholder ?? 'Take notes. Drop or paste screenshots anywhere on this surface.'
        }
        spellCheck
      />
      {!loaded && <div className="notes-editor-loading">Loading…</div>}
      {savedAt && (
        <div className="notes-editor-saved">Saved · {new Date(savedAt).toLocaleTimeString()}</div>
      )}
      {dragActive && (
        <div className="notes-editor-drop-overlay" aria-hidden>
          <div>Drop image to attach</div>
        </div>
      )}
    </div>
  );
}

function appendTextWithBreaks(parent: HTMLElement, text: string): void {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) parent.appendChild(document.createTextNode(parts[i]!));
    if (i < parts.length - 1) parent.appendChild(document.createElement('br'));
  }
}

/**
 * Walk the editor's DOM backward from the current selection (or end of
 * the editor if there's no selection inside it) until we hit either:
 *   - the previous image attachment, or
 *   - the beginning of the editor.
 * Then collect the text in between. This gives us "what the user was
 * typing just before they dropped the screenshot" as a natural caption.
 *
 * Capped at 500 chars to avoid pulling in the entire note as a single
 * "observation" if there are no images yet.
 */
function collectPrecedingObservation(root: HTMLElement): string {
  // Find the anchor node (where the cursor currently is). Fall back to
  // the last child when there's no selection inside the editor.
  let anchor: Node | null = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0 && root.contains(sel.anchorNode)) {
    anchor = sel.anchorNode;
  } else {
    anchor = root.lastChild;
  }
  if (!anchor) return '';

  // Build a flat list of all text/img descendants in document order so
  // we can step backward easily.
  const sequence: Node[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = (n as Element).tagName.toLowerCase();
        if (tag === 'img' || tag === 'br') return NodeFilter.FILTER_ACCEPT;
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
  let cur: Node | null = walker.nextNode();
  while (cur) {
    sequence.push(cur);
    cur = walker.nextNode();
  }

  // Find the anchor's position in the sequence.
  let anchorIdx = sequence.indexOf(anchor);
  if (anchorIdx === -1) {
    // Anchor isn't a leaf node we care about (e.g. it's a container);
    // fall back to the last leaf before it in document order.
    for (let i = sequence.length - 1; i >= 0; i--) {
      const n = sequence[i]!;
      const cmp = anchor.compareDocumentPosition(n);
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
        anchorIdx = i;
        break;
      }
    }
    if (anchorIdx === -1) anchorIdx = sequence.length - 1;
  }

  // Walk backward, collecting text until we hit an <img>.
  const collected: string[] = [];
  for (let i = anchorIdx; i >= 0; i--) {
    const n = sequence[i]!;
    if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName.toLowerCase();
      if (tag === 'img') break;
      if (tag === 'br') {
        collected.push('\n');
        continue;
      }
    }
    if (n.nodeType === Node.TEXT_NODE) {
      collected.push(n.nodeValue ?? '');
    }
  }
  return collected.reverse().join('').replace(/\s+/g, ' ').trim().slice(-500);
}
