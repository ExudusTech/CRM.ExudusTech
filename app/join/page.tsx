import { JoinClient } from './JoinClient'

/**
 * Componente React `JoinPage`.
 *
 * @param {{ searchParams?: { token?: string | string[] | undefined; } | undefined; }} {
  searchParams,
} - Parâmetro `{
  searchParams,
}`.
 * @returns {Element} Retorna um valor do tipo `Element`.
 */
export default function JoinPage({
  searchParams,
}: {
  searchParams?: { token?: string | string[] }
}) {
  const token =
    typeof searchParams?.token === 'string'
      ? searchParams.token
      : Array.isArray(searchParams?.token)
        ? searchParams?.token?.[0] ?? null
        : null

  return <JoinClient token={token} />
}
