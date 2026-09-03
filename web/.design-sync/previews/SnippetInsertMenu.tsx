import { SnippetInsertMenu } from '@janusly/web'
import { Stage } from './_stage'

/**
 * The canvas insert menu: built-in step snippets grouped ahead of the
 * workspace's own saved ones, so an author can drop a configured HTTP call or
 * a human-approval gate without wiring it by hand.
 *
 * `open={false}` renders nothing at all, which is correct behaviour and an
 * empty card cell — only the open state is shown.
 */
export function Open() {
  return (
    <Stage minHeight={620}>
      <SnippetInsertMenu open onClose={() => {}} />
    </Stage>
  )
}
