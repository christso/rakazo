import { Trans, useLingui } from "@lingui/react/macro";
import type { SavedAccountSummary } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { Check, UserPlus, X } from "lucide-react";
import type { RefObject } from "react";
import { AccountAvatar } from "./AccountAvatar";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  accounts: SavedAccountSummary[];
  activeUserId?: string | null;
  signingOut: boolean;
  onSwitchAccount?: (userId: string) => void;
  onAddAccount?: () => void;
};

export function SavedAccountSwitcher({
  open,
  onOpenChange,
  triggerRef,
  accounts,
  activeUserId,
  signingOut,
  onSwitchAccount,
  onAddAccount,
}: Props) {
  const { t } = useLingui();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={triggerRef}
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Switch accounts</Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogClose
          aria-label={t`Close`}
          render={<Button variant="ghost" className="absolute top-4.5 right-4.5" size="icon-sm" />}
        >
          <X aria-hidden="true" />
        </DialogClose>
        <div className="min-w-0">
          {accounts.map((account) => {
            const display = accountDisplay(account, account.email);
            const selected = account.userId === activeUserId;
            return (
              <Button
                key={account.userId}
                variant="ghost"
                className="h-auto w-full justify-start gap-2.5 py-2 font-normal disabled:opacity-100"
                aria-current={selected ? "true" : undefined}
                disabled={signingOut || selected}
                onClick={() => {
                  onOpenChange(false);
                  onSwitchAccount?.(account.userId);
                }}
              >
                <AccountAvatar
                  image={display.image}
                  initials={display.initial}
                  className="size-6 text-caption"
                />
                <span className="min-w-0 flex-1 text-start">
                  <span className="block truncate">{display.label}</span>
                  {display.label !== account.email ? (
                    <span className="block truncate text-label text-muted-foreground">
                      {account.email}
                    </span>
                  ) : null}
                </span>
                <span className="grid size-4 shrink-0 place-items-center">
                  {selected ? <Check aria-hidden="true" size={16} /> : null}
                </span>
                {account.unread > 0 ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {account.unread}
                  </Badge>
                ) : null}
              </Button>
            );
          })}
          {onAddAccount ? (
            <Button
              variant="ghost"
              className="h-9 w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={() => {
                onOpenChange(false);
                onAddAccount();
              }}
            >
              <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Add account</Trans>
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
