import { useEffect, useRef, useState } from 'react';

interface NewTeamDialogProps {
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

export function NewTeamDialog({ onCancel, onCreate }: NewTeamDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
        <h3>New team</h3>

        <div className="modal-row">
          <label htmlFor="team-name">Name</label>
          <input
            id="team-name"
            ref={inputRef}
            value={name}
            onChange={(e) => updateName(e.target.value)}
            placeholder="e.g. Platform, Personal, Onboarding"
          />
        </div>

        <div className="modal-row">
          <label htmlFor="team-slug">Slug</label>
          <input
            id="team-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="auto-generated"
          />
        </div>

        <div className="modal-row">
          <label htmlFor="team-description">Description (optional)</label>
          <textarea
            id="team-description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this team about?"
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
