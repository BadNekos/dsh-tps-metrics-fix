/** Reuse the original trajectory messages and token-speed formatting. */
export function throughputText(reading, t) {
  if (reading.rate !== null) return t('unit.tokensPerSecond', { value: reading.rate.toFixed(1) });
  switch (reading.reason) {
    case 'pending': return t('status.pending');
    case 'missing-start': return t('timing.stepStartUnavailable');
    case 'not-recorded': return t('timing.notRecorded');
    case 'missing-usage':
    case 'contradictory-usage': return t('timing.usageUnavailable');
    case 'invalid-usage': return t('timing.outputTokensUnavailable');
    case 'too-short':
    case 'zero-duration':
    case 'clock-regression': return t('timing.durationTooShort');
    default: return t('timing.notAvailable');
  }
}

/** Clone only the original throughput value; all original text, styles and other rows survive. */
export function replaceThroughputValue(panel, value, React) {
  const rows = panel?.props?.children;
  if (!React.isValidElement(panel) || panel.type !== 'dl' || !Array.isArray(rows) || rows.length !== 5) {
    throw new Error('Unsupported original trajectory timing panel');
  }
  const row = rows[4];
  const cells = row?.props?.children;
  if (!React.isValidElement(row) || row.type !== 'div' || !Array.isArray(cells) || cells.length !== 2
    || !React.isValidElement(cells[0]) || cells[0].type !== 'dt'
    || !React.isValidElement(cells[1]) || cells[1].type !== 'dd') {
    throw new Error('Unsupported original throughput value');
  }
  const nextValue = React.cloneElement(cells[1], { key: cells[1].key ?? 'throughput-value', children: value });
  const nextRow = React.cloneElement(row, { key: row.key ?? 'throughput', children: [cells[0], nextValue] });
  return React.cloneElement(panel, { children: [...rows.slice(0, 4), nextRow] });
}
