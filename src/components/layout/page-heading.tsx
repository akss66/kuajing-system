import type { ReactNode } from "react";

type Breadcrumb = {
  href?: string;
  label: string;
};

type PageHeadingProps = {
  action?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  description?: ReactNode;
  title: ReactNode;
};

export function PageHeading({ action, breadcrumbs = [], description, title }: PageHeadingProps) {
  return (
    <section
      className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-end sm:justify-between"
      data-page-heading
    >
      <div className="min-w-0 space-y-2">
        {breadcrumbs.length ? (
          <nav aria-label="页面路径" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {breadcrumbs.map((item, index) => (
              <span className="flex items-center gap-2" key={`${item.label}-${index}`}>
                {item.href ? (
                  <a className="transition-colors hover:text-foreground" href={item.href}>
                    {item.label}
                  </a>
                ) : (
                  <span>{item.label}</span>
                )}
                {index < breadcrumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="space-y-1.5">
          <h1 className="text-[1.9rem] font-semibold tracking-[-0.03em] text-foreground sm:text-[2rem]">{title}</h1>
          {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </section>
  );
}
