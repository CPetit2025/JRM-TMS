/** Only temporary read failures may be retried. Never use this for writes. */
export function isTransientAptReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/unauthorized|forbidden|permission|not authenticated|jwt|session|sesión|acceso denegado|no tiene acceso|no autorizado|42501|PGRST30/i.test(message)) return false
  return /statement timeout|query.*timed? out|network|failed to fetch|fetch failed|load failed|connection|conexión|gateway|503|504|57014/i.test(message)
}

export const APT_READ_RETRY_DELAY = 700

/** Canceling stops both the retry timer and publication of late responses. */
export function startRecoverableRead<T>(options: {
  read: () => Promise<T>
  onSuccess: (value: T) => void
  onError: (error: unknown) => void
  onRetry: () => void
  retryDelay?: number
}) {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = async (retried: boolean) => {
    try {
      const result = await options.read()
      if (active) options.onSuccess(result)
    } catch (error) {
      if (!active) return
      if (!retried && isTransientAptReadError(error)) {
        options.onRetry()
        timer = setTimeout(() => { if (active) void attempt(true) }, options.retryDelay ?? APT_READ_RETRY_DELAY)
      } else options.onError(error)
    }
  }
  void attempt(false)
  return () => { active = false; if (timer !== undefined) clearTimeout(timer) }
}
