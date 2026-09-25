import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseConversationShareCodeInput } from "@/lib/conversationShareCodeInput.js";

export interface SharedContextImportRequest {
  shareCode: string;
  clientRequestId: string;
}

export interface SharedContextImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (request: SharedContextImportRequest) => Promise<boolean>;
}

function createClientRequestId(): string {
  return `share-import-request-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

export function SharedContextImportDialog({
  open,
  onOpenChange,
  onImport,
}: SharedContextImportDialogProps) {
  const { intl } = useZCodeIntl();
  const [shareInput, setShareInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const pendingRequestRef = useRef<SharedContextImportRequest | null>(null);
  const shareCode = parseConversationShareCodeInput(shareInput);

  const handleOpenChange = (nextOpen: boolean) => {
    if (submitting) return;
    if (!nextOpen) {
      setShareInput("");
      setImportFailed(false);
      pendingRequestRef.current = null;
    }
    onOpenChange(nextOpen);
  };

  const submit = async () => {
    if (!shareCode || submitting) return;
    setSubmitting(true);
    setImportFailed(false);
    const request =
      pendingRequestRef.current?.shareCode === shareCode
        ? pendingRequestRef.current
        : { shareCode, clientRequestId: createClientRequestId() };
    pendingRequestRef.current = request;
    try {
      if (await onImport(request)) {
        setShareInput("");
        pendingRequestRef.current = null;
        onOpenChange(false);
      } else {
        setImportFailed(true);
      }
    } catch {
      setImportFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="conversation-share-import-dialog">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "chat.composer.importSharedContext.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "chat.composer.importSharedContext.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <label htmlFor="conversation-share-import-input" className="text-ui-sm font-medium">
            {intl.formatMessage({ id: "chat.composer.importSharedContext.label" })}
          </label>
          <Input
            id="conversation-share-import-input"
            value={shareInput}
            placeholder={intl.formatMessage({
              id: "chat.composer.importSharedContext.placeholder",
            })}
            aria-invalid={Boolean(shareInput.trim()) && !shareCode}
            data-testid="conversation-share-import-input"
            disabled={submitting}
            onChange={(event) => {
              setShareInput(event.target.value);
              setImportFailed(false);
              pendingRequestRef.current = null;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {shareInput.trim() && !shareCode ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "chat.composer.importSharedContext.invalid" })}
            </p>
          ) : null}
          {importFailed ? (
            <p
              role="alert"
              data-testid="conversation-share-import-error"
              className="text-ui-sm text-destructive"
            >
              {intl.formatMessage({ id: "chat.composer.importSharedContext.failed" })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            {intl.formatMessage({ id: "chat.composer.importSharedContext.cancel" })}
          </Button>
          <Button
            type="button"
            data-testid="conversation-share-import-submit"
            disabled={!shareCode || submitting}
            onClick={() => void submit()}
          >
            {intl.formatMessage({
              id: submitting
                ? "chat.composer.importSharedContext.submitting"
                : "chat.composer.importSharedContext.submit",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
