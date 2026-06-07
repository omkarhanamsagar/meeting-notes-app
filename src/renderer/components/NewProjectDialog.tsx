import { useEffect, useRef, useState } from 'react';

interface NewProjectDialogProps {
  onCancel: () => void;
  onCreate: (slug: string, name: string, description: string) => void;
}

function autoSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function NewProjectDialog({ onCancel, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-derive slug from name unless the user has explicitly edited slug.
  function updateName(value: string) {
    setName(value);
    if (!slugTouched) setSlug(autoSlug(value));
  }

  function submit() {
    const finalSlug = slug.trim() || autoSlug(name);
    if (!name.trim() || !finalSlug) return;
    onCreate(finalSlug, name.trim(), description.trim());
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>New project</h3>

        <div className="modal-row">
          <label htmlFor="project-name">Name</label>
          <input
            id="project-name"
            ref={inputRef}
            value={name}
            onChange={(e) => updateName(e.target.value)}
            placeholder="e.g. Q3 Onboarding Redesign"
          />
        </div>

        <div className="modal-row">
          <label htmlFor="project-slug">Slug</label>
          <input
            id="project-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="auto-generated"
          />
        </div>

        <div className="modal-row">
          <label htmlFor="project-description">Description (optional)</label>
          <textarea
            id="project-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One paragraph the AI uses as context for every meeting in this project"
          />
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
