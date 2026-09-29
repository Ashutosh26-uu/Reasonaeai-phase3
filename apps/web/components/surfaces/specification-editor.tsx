import type { EditableSpecification } from "@reasonateai/contracts/intent";
import { Button } from "@reasonateai/ui/components/button";
import { Plus, X } from "lucide-react";
import { type ChangeEvent, useCallback } from "react";

export interface SpecificationEditorProps {
  onChange?: (spec: EditableSpecification) => void;
  specification?: EditableSpecification;
}

export function SpecificationEditor({
  specification,
  onChange,
}: SpecificationEditorProps) {
  const handleChange = useCallback(
    <K extends keyof EditableSpecification>(
      field: K,
      value: EditableSpecification[K]
    ) => {
      if (onChange && specification) {
        onChange({ ...specification, [field]: value });
      }
    },
    [onChange, specification]
  );

  const handleTitleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      handleChange("title", e.target.value);
    },
    [handleChange]
  );

  const handleDescriptionChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      handleChange("description", e.target.value);
    },
    [handleChange]
  );

  const addRequirement = useCallback(() => {
    if (!specification) {
      return;
    }
    handleChange("requirements", [...specification.requirements, ""]);
  }, [handleChange, specification]);

  const handleRequirementChange = useCallback(
    (index: number, value: string) => {
      if (!specification) {
        return;
      }
      const newReqs = [...specification.requirements];
      newReqs[index] = value;
      handleChange("requirements", newReqs);
    },
    [handleChange, specification]
  );

  const handleRequirementRemove = useCallback(
    (index: number) => {
      if (!specification) {
        return;
      }
      const newReqs = [...specification.requirements];
      newReqs.splice(index, 1);
      handleChange("requirements", newReqs);
    },
    [handleChange, specification]
  );

  if (!specification) {
    return (
      <div className="p-4 text-muted-foreground italic">
        No specification to edit.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-1">
        <label
          className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          htmlFor="spec-title"
        >
          Title
        </label>
        <input
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          id="spec-title"
          onChange={handleTitleChange}
          value={specification.title}
        />
      </div>

      <div className="space-y-1">
        <label
          className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          htmlFor="spec-description"
        >
          Description
        </label>
        <textarea
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          id="spec-description"
          onChange={handleDescriptionChange}
          rows={3}
          value={specification.description}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-sm leading-none">Requirements</span>
          <Button
            onClick={addRequirement}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="mr-1 size-3" /> Add
          </Button>
        </div>

        <div className="space-y-2">
          {specification.requirements.map((req, i) => (
            <RequirementItem
              index={i}
              key={i}
              onChange={handleRequirementChange}
              onRemove={handleRequirementRemove}
              value={req}
            />
          ))}
          {specification.requirements.length === 0 && (
            <p className="text-muted-foreground text-sm italic">
              No requirements defined.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface RequirementItemProps {
  index: number;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  value: string;
}

function RequirementItem({
  index,
  value,
  onChange,
  onRemove,
}: RequirementItemProps) {
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(index, e.target.value);
    },
    [index, onChange]
  );

  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);

  return (
    <div className="flex items-start gap-2">
      <label
        className="mt-2 text-muted-foreground text-sm"
        htmlFor={`req-${index}`}
      >
        {index + 1}.
      </label>
      <input
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        id={`req-${index}`}
        onChange={handleChange}
        value={value}
      />
      <Button
        aria-label={`Remove requirement ${index + 1}`}
        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={handleRemove}
        size="icon"
        type="button"
        variant="ghost"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
