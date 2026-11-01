import { ICON_PATHS, type IconName } from './icon-paths';

/** The prototype's `icon(name)`: `<svg class="icon">` with the named paths (unknown → chart). */
export function Icon({ name }: { name: string }) {
  const paths = (ICON_PATHS as Record<string, string>)[name] ?? ICON_PATHS.chart;
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />;
}

/** The prototype's `<span data-icon="…">` placeholder, already drawn. */
export function DataIcon({ name, className }: { name: IconName | string; className?: string }) {
  return <span data-icon={name} className={className}><Icon name={name} /></span>;
}

/** The magenta full stop / question mark after a heading. */
export function RedDot({ mark = '.' }: { mark?: string }) {
  return <span className="red-dot">{mark}</span>;
}
