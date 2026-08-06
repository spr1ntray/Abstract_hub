export type LogLineLevel = 'neutral' | 'success' | 'warning' | 'error' | 'separator';

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

/** Classify rendered CLI output without treating zero-valued metrics as failures. */
export function classifyLogLine(line: string): LogLineLevel {
  const clean = line.replace(ANSI_ESCAPE, '').trim();
  if (!clean) return 'neutral';

  const failedMetric = clean.match(/\bItems failed\s*(?:│|\|)?\s*(\d+)\b/i);
  if (failedMetric) return Number(failedMetric[1]) > 0 ? 'error' : 'neutral';

  if (
    /❌|аккаунт упал с ошибкой|\[ошибка запуска\]/i.test(clean) ||
    /\bHTTP\s+[45]\d{2}\b/i.test(clean) ||
    /(?:^|\s)(?:Error|Ошибка):\s*\S/i.test(clean) ||
    /["']error["']\s*:\s*["'](?!none|false|null)/i.test(clean) ||
    /процесс завершён.*(?:code=[1-9]\d*|signal=(?!none\b)[^),\s]+)/i.test(clean)
  ) {
    return 'error';
  }

  if (
    /⚠|пропуск|недостаточно|не хватает|cooldown|нет энергии|не juiced|сервер не вернул/i.test(
      clean,
    ) ||
    /Умер|\b[1-9]\d*\s+died\b/i.test(clean)
  ) {
    return 'warning';
  }

  if (/✅|готово|успеш|забрал|получено|починен|разбит|все аккаунты обработаны/i.test(clean)) {
    return 'success';
  }

  if (/^(?:\[[^\]]+\]\s*)?[═─-]{3,}/.test(clean)) return 'separator';
  return 'neutral';
}
