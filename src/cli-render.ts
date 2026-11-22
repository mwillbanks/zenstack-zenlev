import { createApp } from '@mwillbanks/tuil'
import { CellRendererBackend, encodeCellOutput, type CellFrame } from '@mwillbanks/tuil-cell'

/** Render a single cell-backed result into terminal scrollback. */
export async function renderTerminal(
  text: string,
  write: (text: string) => void | Promise<void>,
): Promise<void> {
  const lines = text.split('\n')
  const width = Math.max(1, ...lines.map((line) => line.length * 2))
  const backend = new CellRendererBackend()
  const app = createApp({
    id: 'zenlev',
    component: () => null,
    renderers: [backend],
    renderer: 'cell',
    terminal: { mode: 'static', ownership: 'inline' },
  })
  try {
    await app.initialize()
    const frame = await backend.render(
      (buffer) => {
        for (const [row, line] of lines.entries()) buffer.write(0, row, line)
      },
      {
        capabilities: { ...app.capabilities, width, height: lines.length },
        layout: app.layout,
        mode: 'static',
        signal: new AbortController().signal,
      },
    )
    const output = encodeCellOutput(frame.payload as CellFrame, 'static')
    await write(new TextDecoder().decode(output.bytes) + '\n')
  } finally {
    await app.stop()
  }
}
