// ============================================================
// Resilience Layer — Circuit Breaker + Retry + Timeout + Bulkhead
// Protects LLM API calls from cascading failures.
// ============================================================
import {
  circuitBreaker, ConsecutiveBreaker, ExponentialBackoff,
  retry, timeout, bulkhead, wrap, handleAll,
  type IPolicy
} from 'cockatiel'

// ---- LLM API Policies ----

// Retry: transient failures (rate limits, server errors, network blips)
export const llmRetry = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({ exponent: 2, initialDelay: 1000, maxDelay: 30_000 })
})

// Circuit breaker: open after 5 consecutive failures, half-open after 30s
export const llmCircuitBreaker = circuitBreaker(handleAll, {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(5)
})

// Timeout: 2 minutes per LLM call
export const llmTimeout = timeout(120_000)

// Bulkhead: max 2 concurrent LLM API calls
export const llmBulkhead = bulkhead(2)

// Composed policy — apply to all LLM API calls
export const llmPolicy: IPolicy = wrap(llmBulkhead, llmCircuitBreaker, llmRetry, llmTimeout)

// ---- Helper: execute with resilience ----
export async function resilientCall<T>(fn: () => Promise<T>, label = 'llm'): Promise<T> {
  try {
    return await llmPolicy.execute(fn)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Augment with policy context for debugging
    throw new Error(`[${label}] ${msg}`)
  }
}

// ---- Circuit breaker state introspection ----
export function getCircuitState() {
  return {
    llm: llmCircuitBreaker.state // 'closed' | 'open' | 'half-open'
  }
}
