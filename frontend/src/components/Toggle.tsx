'use client';

import type { ChangeEvent } from 'react';

interface ToggleProps {
  checked?: boolean;
  onChange?: (next: boolean, e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  label?: string;
  name?: string;
}

export default function Toggle({
  checked = false,
  onChange,
  disabled = false,
  label,
  name,
}: ToggleProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (onChange) onChange(e.target.checked, e);
  };

  const inputEl = (
    <label className="tsl">
      <input
        type="checkbox"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
      />
      <span className="tsl-track" />
    </label>
  );

  if (!label) return inputEl;

  return (
    <label className="tog">
      {inputEl}
      <span>{label}</span>
    </label>
  );
}
