import { useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

interface MarkdownProps {
  children: string;
  /** When set, any `<img>` whose src is a relative path under the meeting
   *  dir (e.g. `attachments/foo.png`) is resolved through the
   *  `meetings.readAttachment` IPC and rendered as an inline data URL.
   *  This is how screenshots embedded by Claude in the summary show up
   *  inline in the Summary tab. */
  meetingDir?: string;
}

/**
 * Renders markdown with GitHub-flavored extensions and lets through raw HTML
 * (e.g. the <details> blocks we use to hide raw transcripts).
 *
 * When a `meetingDir` is provided, relative image paths are resolved via
 * the renderer-side IPC so the Summary tab can show screenshots that
 * Claude referenced in the generated summary.
 */
export function Markdown({ children, meetingDir }: MarkdownProps) {
  const components: Components | undefined = meetingDir
    ? {
        img: (props) => <ResolvingImage meetingDir={meetingDir} {...props} />,
      }
    : undefined;

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface ResolvingImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  meetingDir: string;
}

/**
 * Loads an attachment via IPC when its src looks like a relative path
 * inside the meeting folder. Absolute / data / http URLs pass through.
 */
function ResolvingImage({ meetingDir, src, alt, ...rest }: ResolvingImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const isRelative =
    !!src &&
    !src.startsWith('http://') &&
    !src.startsWith('https://') &&
    !src.startsWith('data:') &&
    !src.startsWith('blob:') &&
    !src.startsWith('attachment://');

  useEffect(() => {
    if (!isRelative || !src) {
      setResolvedSrc(src ?? null);
      return;
    }
    let cancelled = false;
    void window.api.meetings
      .readAttachment(meetingDir, src)
      .then((dataUrl) => {
        if (cancelled) return;
        if (dataUrl) setResolvedSrc(dataUrl);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingDir, src, isRelative]);

  if (failed) {
    return (
      <span className="md-img-missing" aria-label={`Missing image: ${src}`}>
        [missing: {src}]
      </span>
    );
  }
  if (!resolvedSrc) {
    return (
      <span className="md-img-loading" aria-label={`Loading image: ${src}`}>
        …
      </span>
    );
  }
  return <img src={resolvedSrc} alt={alt ?? ''} className="md-img" {...rest} />;
}
