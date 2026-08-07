import type { Decorator, Preview } from '@storybook/react-vite';
import '../src/index.css';

/**
 * Every story can be viewed light, dark, or both at once. "Both" is the default
 * because the popup ships in both themes and regressions in one are easy to miss
 * when you only ever look at the other.
 */

type ThemeChoice = 'light' | 'dark' | 'side-by-side';

function ThemePane({ theme, children }: { theme: 'light' | 'dark'; children: React.ReactNode }) {
  return (
    <div className={theme === 'dark' ? 'dark' : undefined}>
      <div className="bg-background text-foreground w-fit">{children}</div>
    </div>
  );
}

const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals['theme'] ?? 'side-by-side') as ThemeChoice;

  if (theme === 'side-by-side') {
    return (
      <div className="flex flex-wrap items-start gap-4">
        <ThemePane theme="light">
          <Story />
        </ThemePane>
        <ThemePane theme="dark">
          <Story />
        </ThemePane>
      </div>
    );
  }

  return (
    <ThemePane theme={theme}>
      <Story />
    </ThemePane>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'side-by-side', title: 'Light + dark' },
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'side-by-side',
  },
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
  },
};

export default preview;
