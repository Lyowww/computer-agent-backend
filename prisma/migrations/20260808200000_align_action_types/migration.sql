-- Align ActionType enum with @petai/computer-agent-shared / ai-computer-agent.

CREATE TYPE "ActionType_new" AS ENUM (
  'CLICK',
  'DOUBLE_CLICK',
  'RIGHT_CLICK',
  'MOVE_MOUSE',
  'TYPE_TEXT',
  'KEY_PRESS',
  'HOTKEY',
  'OPEN_APP',
  'WAIT',
  'SCREENSHOT',
  'SCROLL',
  'DRAG',
  'LOCK_SCREEN',
  'UNLOCK_SCREEN',
  'DONE',
  'FAIL',
  'ASK_USER'
);

ALTER TABLE "TaskAction" ALTER COLUMN "type" DROP DEFAULT;

ALTER TABLE "TaskAction"
  ALTER COLUMN "type" TYPE "ActionType_new"
  USING (
    CASE "type"::text
      WHEN 'TYPE' THEN 'TYPE_TEXT'
      WHEN 'KEY' THEN 'KEY_PRESS'
      WHEN 'MOVE' THEN 'MOVE_MOUSE'
      ELSE "type"::text
    END::"ActionType_new"
  );

DROP TYPE "ActionType";
ALTER TYPE "ActionType_new" RENAME TO "ActionType";
