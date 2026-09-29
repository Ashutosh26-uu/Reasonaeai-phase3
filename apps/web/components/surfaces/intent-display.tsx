import type { StructuredIntent } from "@reasonateai/contracts/intent";

export interface IntentDisplayProps {
  intent?: StructuredIntent;
}

export function IntentDisplay({ intent }: IntentDisplayProps) {
  if (!intent) {
    return (
      <div className="rounded-md border p-4 text-muted-foreground text-sm italic">
        No intent detected yet.
      </div>
    );
  }

  const hasScreens = intent.screens && intent.screens.length > 0;
  const hasComponents = intent.components && intent.components.length > 0;
  const hasFeatures =
    intent.inferredFeatures && intent.inferredFeatures.length > 0;
  const hasWorkflow = intent.workflow && intent.workflow.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-4">
        {hasScreens ? (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Screens</h5>
            <div className="flex flex-wrap gap-2">
              {intent.screens.map((screen, i) => (
                <span
                  className="rounded-md border border-border bg-secondary px-2 py-1 font-medium text-secondary-foreground text-xs"
                  key={i}
                >
                  {screen}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Screens</h5>
            <p className="text-muted-foreground text-xs italic">
              No screens identified.
            </p>
          </div>
        )}

        {hasComponents ? (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Components</h5>
            <div className="flex flex-wrap gap-2">
              {intent.components.map((comp, i) => (
                <span
                  className="rounded-md border border-border bg-secondary px-2 py-1 font-medium text-secondary-foreground text-xs"
                  key={i}
                >
                  {comp}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Components</h5>
            <p className="text-muted-foreground text-xs italic">
              No components identified.
            </p>
          </div>
        )}

        {hasWorkflow ? (
          <div>
            <h5 className="mb-1 font-semibold text-sm">Workflow</h5>
            <p className="rounded-md border bg-muted/50 p-3 text-foreground text-sm">
              {intent.workflow}
            </p>
          </div>
        ) : (
          <div>
            <h5 className="mb-1 font-semibold text-sm">Workflow</h5>
            <p className="text-muted-foreground text-xs italic">
              No workflow described.
            </p>
          </div>
        )}

        {hasFeatures ? (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Inferred Features</h5>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground text-sm">
              {intent.inferredFeatures.map((feature, i) => (
                <li className="text-foreground" key={i}>
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div>
            <h5 className="mb-2 font-semibold text-sm">Inferred Features</h5>
            <p className="text-muted-foreground text-xs italic">
              No features inferred.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
