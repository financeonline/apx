/** The prototype's footer — "APX Finance in motion." and what the figures rest on (no Reset demo). */
export function DashFooter({ basis }: { basis: string }) {
  return (
    <footer>
      <span><b>APX</b> Finance in motion.</span>
      <div><span className="demo-indicator" /> {basis}</div>
    </footer>
  );
}
