// SPDX-License-Identifier: GPL-3.0-only

//! Bounded retries for network work whose failures are often momentary.

use std::future::Future;
use std::time::Duration;

/// Waits before each further attempt. Its length is the number of retries after the first try.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    delays: &'static [Duration],
}

impl RetryPolicy {
    /// A file host that drops a connection or answers 503 usually recovers within seconds; past
    /// ten more seconds the player is better served by the failure and a manual retry.
    pub const DOWNLOAD: Self = Self::new(&[
        Duration::from_secs(1),
        Duration::from_secs(3),
        Duration::from_secs(10),
    ]);

    /// The master list is the first thing a player waits on, so it gets fewer, shorter retries.
    pub const MASTER: Self = Self::new(&[Duration::from_secs(1), Duration::from_secs(3)]);

    /// Try once and never again.
    pub const NONE: Self = Self::new(&[]);

    /// A policy with these waits.
    #[must_use]
    pub const fn new(delays: &'static [Duration]) -> Self {
        Self { delays }
    }

    /// How many attempts the policy allows in all.
    #[must_use]
    pub const fn attempts(self) -> usize {
        self.delays.len() + 1
    }

    /// After the zero-based attempt `failed` fails, wait and return `true` when another attempt
    /// is due, or return `false` at once when the failure is permanent or the policy has run out.
    /// For loops whose attempts borrow mutable state that [`Self::run`]'s closure cannot hold.
    pub async fn wait_before_retry(self, failed: usize, transient: bool) -> bool {
        match self.delays.get(failed) {
            Some(delay) if transient => {
                tokio::time::sleep(*delay).await;
                true
            }
            _ => false,
        }
    }

    /// Run `attempt` until it succeeds, fails with an error `is_transient` rejects, or the
    /// policy runs out. `attempt` receives the zero-based attempt number.
    ///
    /// # Errors
    ///
    /// Returns the last attempt's error.
    pub async fn run<T, E, Fut>(
        self,
        is_transient: impl Fn(&E) -> bool,
        mut attempt: impl FnMut(usize) -> Fut,
    ) -> Result<T, E>
    where
        Fut: Future<Output = Result<T, E>>,
    {
        let mut number = 0;
        loop {
            match attempt(number).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if !self.wait_before_retry(number, is_transient(&error)).await {
                        return Err(error);
                    }
                    number += 1;
                }
            }
        }
    }
}

/// Whether an HTTP status says the same request may succeed shortly.
#[must_use]
pub fn transient_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || ((500..=599).contains(&status) && status != 501)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::time::Duration;

    use super::{RetryPolicy, transient_status};

    const INSTANT: RetryPolicy = RetryPolicy::new(&[Duration::ZERO, Duration::ZERO]);

    #[tokio::test]
    async fn a_transient_failure_is_retried_until_it_succeeds() {
        let calls = Cell::new(0);
        let result: Result<&str, &str> = INSTANT
            .run(
                |_| true,
                |number| {
                    calls.set(calls.get() + 1);
                    async move {
                        if number < 2 {
                            Err("dropped")
                        } else {
                            Ok("done")
                        }
                    }
                },
            )
            .await;
        assert_eq!(result, Ok("done"));
        assert_eq!(calls.get(), 3);
    }

    #[tokio::test]
    async fn a_permanent_failure_is_returned_at_once() {
        let calls = Cell::new(0);
        let result: Result<(), &str> = INSTANT
            .run(
                |_| false,
                |_| {
                    calls.set(calls.get() + 1);
                    async { Err("not found") }
                },
            )
            .await;
        assert_eq!(result, Err("not found"));
        assert_eq!(calls.get(), 1);
    }

    #[tokio::test]
    async fn the_last_error_is_returned_once_the_policy_runs_out() {
        let calls = Cell::new(0);
        let result: Result<(), usize> = INSTANT
            .run(
                |_| true,
                |number| {
                    calls.set(calls.get() + 1);
                    async move { Err(number) }
                },
            )
            .await;
        assert_eq!(result, Err(2));
        assert_eq!(calls.get(), INSTANT.attempts());
    }

    #[test]
    fn only_statuses_that_can_clear_by_themselves_are_transient() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert!(transient_status(status), "{status}");
        }
        for status in [400, 401, 403, 404, 410, 501] {
            assert!(!transient_status(status), "{status}");
        }
    }
}
