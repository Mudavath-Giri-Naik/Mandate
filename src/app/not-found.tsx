import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-6 py-24 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nothing here</h1>
      <p className="mt-2 text-sm text-muted">
        That product or page does not exist.
      </p>
      <Link
        href="/"
        className="mt-8 inline-block rounded-md bg-stone-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700"
      >
        Back to shop
      </Link>
    </div>
  );
}
