import type { JSX } from "preact";

type IconProps = { size?: number; class?: string; stroke?: number };

function icon(paths: JSX.Element) {
  return ({ size = 16, class: className, stroke = 1.6 }: IconProps) => (
    <svg
      class={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths}
    </svg>
  );
}

export const InboxIcon = icon(
  <>
    <path d="M3.5 13.5 6 5.8A1.8 1.8 0 0 1 7.7 4.5h8.6A1.8 1.8 0 0 1 18 5.8l2.5 7.7" />
    <path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5l-1.2 2.2h-4.6L8.5 13.5z" />
  </>,
);
export const BotIcon = icon(
  <>
    <rect x="4.5" y="8" width="15" height="11" rx="3" />
    <path d="M12 4.5V8M9.5 13h.01M14.5 13h.01M9.5 16h5" />
  </>,
);
export const RouteIcon = icon(
  <>
    <circle cx="6" cy="6" r="2" />
    <circle cx="18" cy="18" r="2" />
    <path d="M8 6h6.5a3.5 3.5 0 0 1 0 7h-5a3.5 3.5 0 0 0 0 7H16" />
  </>,
);
export const PulseIcon = icon(<path d="M3 12h4l2.5-6 5 12 2.5-6h4" />);
export const GearIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" />
  </>,
);
export const CopyIcon = icon(
  <>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </>,
);
export const CheckIcon = icon(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const SearchIcon = icon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </>,
);
export const PlusIcon = icon(<path d="M12 5v14M5 12h14" />);
export const RefreshIcon = icon(
  <>
    <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" />
    <path d="M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4" />
  </>,
);
export const KeyIcon = icon(
  <>
    <circle cx="8" cy="15" r="3.5" />
    <path d="m10.5 12.5 8-8M15.5 7.5l2 2M17.5 5.5l2 2" />
  </>,
);
export const BoltIcon = icon(<path d="M13 3.5 5.5 13.5H12l-1 7 7.5-10H12z" />);
export const ChevronRight = icon(<path d="m9.5 6 6 6-6 6" />);
export const ChevronLeft = icon(<path d="m14.5 6-6 6 6 6" />);
export const ChevronDown = icon(<path d="m6 9.5 6 6 6-6" />);
export const PaperclipIcon = icon(<path d="m19 11.5-7.2 7.2a4.5 4.5 0 0 1-6.4-6.4l7.6-7.6a3 3 0 0 1 4.2 4.3l-7.5 7.5a1.5 1.5 0 0 1-2.1-2.1l6.9-6.9" />);
export const DownloadIcon = icon(<path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />);
export const MailIcon = icon(
  <>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </>,
);
export const SendIcon = icon(<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z" />);
export const ShieldIcon = icon(
  <>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </>,
);
export const TrashIcon = icon(<path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v5M14 11v5" />);
export const XIcon = icon(<path d="M6 6l12 12M18 6 6 18" />);
export const AlertIcon = icon(
  <>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4.5M12 17h.01" />
  </>,
);
export const LockIcon = icon(
  <>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  </>,
);
export const ArrowLeft = icon(<path d="M19 12H5.5M11 6l-6 6 6 6" />);
export const ExternalIcon = icon(<path d="M13.5 4.5h6v6M19.5 4.5 11 13M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10" />);
export const LogoutIcon = icon(<path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16.5 5.5 12 10 7.5M5.5 12h10" />);
export const EyeIcon = icon(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.8" />
  </>,
);
export const EyeOffIcon = icon(<path d="M4 4l16 16M10.6 6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.6 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.4-1.1M10 10a2.8 2.8 0 0 0 4 4" />);
export const MenuIcon = icon(<path d="M4 7h16M4 12h16M4 17h16" />);
export const CommandIcon = icon(<path d="M9 6.5A2.5 2.5 0 1 0 6.5 9H9zm0 0v11m0-11h6m-6 11A2.5 2.5 0 1 1 6.5 15H9zm0 0h6m0 0V6.5m0 11a2.5 2.5 0 1 0 2.5-2.5H15zm0-11A2.5 2.5 0 1 1 17.5 9H15z" />);
export const DotIcon = icon(<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />);
export const GlobeIcon = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5S9.6 6 12 3.5z" />
  </>,
);
export const PlugIcon = icon(<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4" />);
export const MailOpenIcon = icon(
  <>
    <path d="M3.5 10 12 4l8.5 6v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="m4 10.5 8 5.5 8-5.5" />
  </>,
);
export const CodeIcon = icon(<path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5M13.5 5l-3 14" />);
export const NotesIcon = icon(
  <>
    <path d="M6.5 3.5h8l4 4v11a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z" />
    <path d="M14.5 3.5v4h4M8.5 12h7M8.5 15.5h5" />
  </>,
);
