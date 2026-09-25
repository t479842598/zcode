import { useOptionalPlatform } from "@/hooks/usePlatform.js";

const GITHUB_REPOSITORY_URL = "https://github.com/t479842598/Zcode_Full";

/** 仅草稿欢迎屏展示项目出处；不改已创建会话或移动端页面。 */
export function ConversationDraftAttribution() {
  const platform = useOptionalPlatform();
  return (
    <div
      data-testid="zcode-selfhost-attribution"
      className="relative z-10 mt-2 text-center text-xs text-foreground-subtle"
    >
      <div className="font-medium text-foreground">Zcode_满血_青棠</div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => platform?.openExternal(GITHUB_REPOSITORY_URL)}
        >
          GitHub：{GITHUB_REPOSITORY_URL}
        </button>
      </div>
    </div>
  );
}
