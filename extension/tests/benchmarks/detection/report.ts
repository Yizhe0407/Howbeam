import type { AccuracyResult, BenchmarkSummary, ReplayResult } from './metrics';

export interface DetectionBenchmarkReport {
  schemaVersion: 1;
  generatedAt: string;
  browser: string;
  commit: string;
  environment: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    headless: boolean;
  };
  summary: BenchmarkSummary;
  accuracy: AccuracyResult[];
  replay: ReplayResult[];
  comparison?: Record<string, number | string>;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

export function renderMarkdown(report: DetectionBenchmarkReport): string {
  const { summary } = report;
  const accuracyFailures = report.accuracy.filter((result) => result.status === 'wrong' || result.status === 'miss');
  const replayFailures = report.replay.filter((result) => !result.passed);
  const lines = [
    '# Howbeam detection benchmark',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Commit: \`${report.commit}\``,
    `- Browser: ${report.browser}`,
    `- Viewport: ${report.environment.viewport.width}×${report.environment.viewport.height} @ DPR ${report.environment.deviceScaleFactor}`,
    '',
    '## Accuracy summary',
    '',
    '| Mode | Cases | Exact | Semantic | Wrong | Miss | Median IoU | Hover p50 | Hover p95 | Hover p99 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| Activation | ${summary.activation.cases} | ${percent(summary.activation.exactAccuracy)} | ${percent(summary.activation.semanticAccuracy)} | ${summary.activation.wrong} | ${summary.activation.miss} | ${summary.activation.medianIoU.toFixed(3)} | ${formatMs(summary.activation.latency.p50)} | ${formatMs(summary.activation.latency.p95)} | ${formatMs(summary.activation.latency.p99)} |`,
    `| Annotation | ${summary.annotation.cases} | ${percent(summary.annotation.exactAccuracy)} | ${percent(summary.annotation.semanticAccuracy)} | ${summary.annotation.wrong} | ${summary.annotation.miss} | ${summary.annotation.medianIoU.toFixed(3)} | ${formatMs(summary.annotation.latency.p50)} | ${formatMs(summary.annotation.latency.p95)} | ${formatMs(summary.annotation.latency.p99)} |`,
    `| Overall | ${summary.overall.cases} | ${percent(summary.overall.exactAccuracy)} | ${percent(summary.overall.semanticAccuracy)} | ${summary.overall.wrong} | ${summary.overall.miss} | ${summary.overall.medianIoU.toFixed(3)} | ${formatMs(summary.overall.latency.p50)} | ${formatMs(summary.overall.latency.p95)} | ${formatMs(summary.overall.latency.p99)} |`,
    '',
    '## Replay summary',
    '',
    `- Passed exactly once: ${summary.replay.passed}/${summary.replay.cases} (${percent(summary.replay.exactlyOnceRate)})`,
    `- Median captured-bounds IoU: ${summary.replay.medianBoundsIoU.toFixed(3)}`,
    `- Click-to-persist latency: p50 ${formatMs(summary.replay.latency.p50)}, p95 ${formatMs(summary.replay.latency.p95)}, p99 ${formatMs(summary.replay.latency.p99)}`,
    '',
  ];

  if (report.comparison && Object.keys(report.comparison).length > 0) {
    lines.push('## Baseline comparison', '');
    for (const [key, value] of Object.entries(report.comparison)) {
      lines.push(`- ${key}: ${typeof value === 'number' ? value.toFixed(3) : value}`);
    }
    lines.push('');
  }

  lines.push('## Accuracy failures', '');
  if (accuracyFailures.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Case | Mode | Category | Status | Best IoU |', '| --- | --- | --- | --- | ---: |');
    for (const result of accuracyFailures) {
      lines.push(`| ${result.id} | ${result.mode} | ${result.category} | ${result.status} | ${result.bestIoU.toFixed(3)} |`);
    }
    lines.push('');
  }

  lines.push('## Replay failures', '');
  if (replayFailures.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Case | Observed | Bounds IoU | Forbidden events |', '| --- | ---: | ---: | --- |');
    for (const result of replayFailures) {
      lines.push(`| ${result.id} | ${result.observedCount} | ${result.boundsIoU.toFixed(3)} | \`${JSON.stringify(result.forbiddenCounts)}\` |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
