/** The fixed-width shell shared by every screen the popup can show. */
export function PopupFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background text-foreground flex w-[22rem] flex-col gap-3 p-3.5">
      {children}
    </div>
  );
}
