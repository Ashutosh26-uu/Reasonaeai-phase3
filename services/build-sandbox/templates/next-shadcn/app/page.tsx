import { ArrowUpRight, Blocks, Code2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const buildingBlocks = [
  {
    description:
      "Responsive layouts, sections, and navigation are ready to shape.",
    icon: Blocks,
    title: "A flexible foundation",
  },
  {
    description:
      "Add routes, data, and server actions as your product takes shape.",
    icon: Code2,
    title: "A real app runtime",
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-6xl flex-col px-6 py-8 sm:px-10 sm:py-12">
      <header className="flex items-center justify-between">
        <a
          aria-label="Home"
          className="flex items-center gap-2 font-semibold"
          href="/"
        >
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles aria-hidden="true" className="size-4" />
          </span>
          <span>New app</span>
        </a>
        <Badge variant="secondary">Ready to customize</Badge>
      </header>

      <section className="grid flex-1 items-center gap-12 py-16 md:grid-cols-[1.15fr_0.85fr] md:py-24">
        <div className="max-w-2xl">
          <p className="mb-5 font-medium text-primary text-sm">
            Your project starts here
          </p>
          <h1 className="font-semibold text-4xl tracking-tight sm:text-6xl">
            A clean foundation for your next idea.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground leading-8">
            Next.js, React, Tailwind CSS, and editable shadcn-style components
            are ready. Describe the product you want and make this workspace
            yours.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button>
              Start building{" "}
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </Button>
            <Button variant="outline">Explore the components</Button>
          </div>
        </div>

        <div className="grid gap-4">
          {buildingBlocks.map(({ description, icon: Icon, title }) => (
            <Card key={title}>
              <CardHeader className="flex-row items-center gap-4">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <div className="space-y-1">
                  <CardTitle className="text-base">{title}</CardTitle>
                  <CardDescription>{description}</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div
                  aria-hidden="true"
                  className="h-1.5 overflow-hidden rounded-full bg-secondary"
                >
                  <div className="h-full w-2/3 rounded-full bg-primary/70" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t pt-5 text-muted-foreground text-sm">
        <span>Edit app/page.tsx to start shaping your product.</span>
        <span>Next.js · React · shadcn/ui</span>
      </footer>
    </main>
  );
}
