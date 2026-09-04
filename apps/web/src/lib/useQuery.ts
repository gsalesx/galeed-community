/** M8/S3 — hooks de dados caseiros (sem TanStack/axios; só estado local + AbortController).
 *
 *  useQuery<T>(key, fetcher, deps?) → { data, error, loading, refetch }
 *    - dispara o fetcher no mount e quando `deps` mudam (key entra nas deps).
 *    - cancela a requisição anterior via AbortController (evita race / set após unmount).
 *    - sem cache global: cada hook tem seu próprio estado.
 *
 *  useMutation<TArgs, TData>(fn) → { mutate, data, error, loading, reset }
 *    - dispara sob demanda; expõe estado e o erro tipado (ApiError).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface QueryState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  refetch: () => void;
}

/** Fetcher recebe um AbortSignal opcional (use-o no fetch para cancelar). */
export type Fetcher<T> = (signal?: AbortSignal) => Promise<T>;

export function useQuery<T>(key: string, fetcher: Fetcher<T>, deps: unknown[] = []): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  // tick força refetch manual sem mexer nas deps do caller
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);

    fetcherRef
      .current(ctrl.signal)
      .then((res) => {
        if (active) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!active || ctrl.signal.aborted) return;
        if ((e as Error)?.name === "AbortError") return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });

    return () => {
      active = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, ...deps]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refetch };
}

export interface MutationState<TArgs, TData> {
  mutate: (args: TArgs) => Promise<TData>;
  data: TData | null;
  error: ApiError | Error | null;
  loading: boolean;
  reset: () => void;
}

export function useMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
): MutationState<TArgs, TData> {
  const [data, setData] = useState<TData | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const mutate = useCallback(async (args: TArgs): Promise<TData> => {
    setLoading(true);
    setError(null);
    try {
      const res = await fnRef.current(args);
      if (mounted.current) {
        setData(res);
        setLoading(false);
      }
      return res;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (mounted.current) {
        setError(err);
        setLoading(false);
      }
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { mutate, data, error, loading, reset };
}
