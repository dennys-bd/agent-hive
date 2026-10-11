import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { FieldCell } from '@/components/FieldCell';

test('a field cell is a button with the value and the ⌄ at its right, inside its column, with the input border on hover (#60)', () => {
  render(<FieldCell aria-label="editar Priority">P1</FieldCell>);
  const cell = screen.getByRole('button', { name: 'editar Priority' });
  expect(cell).toHaveAttribute('type', 'button');
  expect(cell).toHaveAttribute('data-slot', 'field-cell');
  expect(cell).toHaveTextContent('P1');
  expect(cell).toHaveClass('w-full', 'min-w-0', 'px-1.5', 'border-transparent', 'hover:border-input', 'hover:bg-card');
  expect(cell.querySelector('svg')).toHaveClass('ml-auto', 'size-3', 'opacity-60');
});
