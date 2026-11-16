import "./dom-polyfill-guard";
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import { t } from "@lingui/core/macro";
import { createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import { withTrustedUserGesture } from "./rpc-functions";
import {
  Catalog,
  type ActionDispatchOptions,
  type FunctionImplementation,
  type ResolvedChildRef
} from "@a2ui/web_core/v1_0";
import {
  AudioPlayerApi,
  BasicCatalogThemeSchema,
  ButtonApi,
  CardApi,
  CheckBoxApi,
  ChoicePickerApi,
  ColumnApi,
  createBasicCatalogFunctions,
  DateTimeInputApi,
  DividerApi,
  IconApi,
  ImageApi,
  ListApi,
  ModalApi,
  RowApi,
  SliderApi,
  TabsApi,
  TextApi,
  TextFieldApi,
  VideoApi
} from "@a2ui/web_core/catalogs/basic/v1";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  BellOff,
  Bookmark,
  Calendar,
  Camera,
  Check,
  CreditCard,
  Download,
  Edit3,
  Eye,
  EyeOff,
  FastForward,
  Folder,
  Heart,
  HeartOff,
  HelpCircle,
  Home,
  Image as ImageIcon,
  Info,
  Lock,
  Mail,
  MapPin,
  Menu,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Pause,
  Phone,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Rewind,
  Search,
  Send,
  Settings,
  Share2,
  ShoppingCart,
  SkipBack,
  SkipForward,
  Square,
  Star,
  StarHalf,
  StarOff,
  Trash2,
  Unlock,
  Upload,
  User,
  UserCircle2,
  Volume,
  Volume1,
  Volume2,
  VolumeX,
  X,
  type LucideIcon
} from "lucide-react";
import { AssistantMarkdown } from "../../components/chat/AssistantMarkdown";

export const BASIC_CATALOG_ID = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

/**
 * Compact 8-component subset used by `ComponentPruningTransformer` when running
 * on Chrome's built-in Gemini Nano (~8K token context window).
 */
export const NANO_CORE_COMPONENTS = [
  "Card",
  "Column",
  "Row",
  "Text",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker"
] as const;

const InsideButtonContext = createContext(false);

interface SurfaceFormContextValue {
  submitAttempt: number;
  notifySubmitAttempt: () => void;
}

const SurfaceFormContext = createContext<SurfaceFormContextValue>({
  submitAttempt: 0,
  notifySubmitAttempt: () => {}
});

export function A2uiFormBoundary({ children }: { children: ReactNode }) {
  const [submitAttempt, setSubmitAttempt] = useState(0);
  const notifySubmitAttempt = useCallback(() => {
    setSubmitAttempt((count) => count + 1);
  }, []);
  const value = useMemo(
    () => ({ submitAttempt, notifySubmitAttempt }),
    [submitAttempt, notifySubmitAttempt]
  );
  return (
    <SurfaceFormContext.Provider value={value}>
      {children}
    </SurfaceFormContext.Provider>
  );
}

/**
 * Maps numeric `weight` values to static CSS `data-weight` buckets (`1`..`12`)
 * so layout flex-grow works with zero inline `style` attributes under strict
 * `style-src 'self'` CSP.
 */
function weightBucket(weight: number | undefined): string | undefined {
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
    return undefined;
  }
  const clamped = Math.min(12, Math.max(1, Math.round(weight)));
  return String(clamped);
}

type ChildEntry = string | ResolvedChildRef;

function renderChildList(
  children: readonly ChildEntry[] | undefined,
  buildChild: (id: string, basePath?: string) => ReactNode
): ReactNode[] {
  if (!Array.isArray(children)) return [];
  return children.map((item, index) => {
    if (typeof item === "string") {
      return <Fragment key={`${item}-${index}`}>{buildChild(item)}</Fragment>;
    }
    if (item && typeof item === "object" && typeof item.id === "string") {
      return (
        <Fragment key={`${item.id}-${item.basePath ?? ""}-${index}`}>
          {buildChild(item.id, item.basePath)}
        </Fragment>
      );
    }
    return null;
  });
}

interface CheckablePropsSlice {
  isValid?: boolean;
  validationErrors?: string[];
}

function useFieldValidation(props: CheckablePropsSlice) {
  const { submitAttempt } = useContext(SurfaceFormContext);
  const [interacted, setInteracted] = useState(false);
  const [blurredAfterEdit, setBlurredAfterEdit] = useState(false);
  const [seenSubmitAttempt, setSeenSubmitAttempt] = useState(submitAttempt);
  const revealedBySubmit = submitAttempt > seenSubmitAttempt;

  const markEdited = useCallback(() => {
    setInteracted(true);
    setBlurredAfterEdit(false);
    setSeenSubmitAttempt(submitAttempt);
  }, [submitAttempt]);

  const markBlurred = useCallback(() => {
    if (interacted) setBlurredAfterEdit(true);
  }, [interacted]);

  const isInvalid = props.isValid === false && (props.validationErrors?.length ?? 0) > 0;
  const showError = isInvalid && (blurredAfterEdit || revealedBySubmit);
  const errorMessage = showError ? props.validationErrors?.[0] ?? "" : "";

  return { showError, errorMessage, markEdited, markBlurred };
}

const ICON_MAP: Record<string, LucideIcon> = {
  accountCircle: UserCircle2,
  add: Plus,
  arrowBack: ArrowLeft,
  arrowForward: ArrowRight,
  attachFile: Paperclip,
  calendarToday: Calendar,
  call: Phone,
  camera: Camera,
  check: Check,
  close: X,
  delete: Trash2,
  download: Download,
  edit: Edit3,
  event: Calendar,
  error: AlertCircle,
  fastForward: FastForward,
  favorite: Heart,
  favoriteOff: HeartOff,
  folder: Folder,
  help: HelpCircle,
  home: Home,
  info: Info,
  locationOn: MapPin,
  lock: Lock,
  lockOpen: Unlock,
  mail: Mail,
  menu: Menu,
  moreVert: MoreVertical,
  moreHoriz: MoreHorizontal,
  notificationsOff: BellOff,
  notifications: Bell,
  pause: Pause,
  payment: CreditCard,
  person: User,
  phone: Phone,
  photo: ImageIcon,
  play: Play,
  print: Printer,
  refresh: RefreshCw,
  rewind: Rewind,
  search: Search,
  send: Send,
  settings: Settings,
  share: Share2,
  shoppingCart: ShoppingCart,
  skipNext: SkipForward,
  skipPrevious: SkipBack,
  star: Star,
  starHalf: StarHalf,
  starOff: StarOff,
  stop: Square,
  upload: Upload,
  visibility: Eye,
  visibilityOff: EyeOff,
  volumeDown: Volume1,
  volumeMute: VolumeX,
  volumeOff: Volume,
  volumeUp: Volume2,
  warning: AlertTriangle
};

const WasmhatchText = createComponentImplementation(TextApi, ({ props }) => {
  const insideButton = useContext(InsideButtonContext);
  const text = props.text === undefined || props.text === null ? "" : String(props.text);
  const variant = props.variant ?? "body";
  if (insideButton) {
    return <span className="a2ui-button-label">{text}</span>;
  }
  return (
    <div
      className="a2ui-text"
      data-variant={variant}
      data-weight={weightBucket(props.weight)}
    >
      <AssistantMarkdown text={text} />
    </div>
  );
});

const WasmhatchImage = createComponentImplementation(ImageApi, ({ props }) => {
  const [failed, setFailed] = useState(false);
  const url = typeof props.url === "string" ? props.url : "";
  const alt = typeof props.description === "string" ? props.description : "";

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (!url || failed) {
    return (
      <div
        className="a2ui-media-fallback"
        data-variant={props.variant ?? "mediumFeature"}
        data-weight={weightBucket(props.weight)}
        role="img"
        aria-label={alt || t`Image preview unavailable`}
      >
        <ImageIcon size={18} aria-hidden="true" />
        <span>{alt || t`Image unavailable under offline/CSP policy`}</span>
      </div>
    );
  }

  return (
    <div
      className="a2ui-image-wrap"
      data-variant={props.variant ?? "mediumFeature"}
      data-weight={weightBucket(props.weight)}
    >
      <img
        className="a2ui-image"
        data-fit={props.fit ?? "fill"}
        src={url}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  );
});

const WasmhatchIcon = createComponentImplementation(IconApi, ({ props }) => {
  const raw = props.name as unknown;
  if (raw && typeof raw === "object" && "svgPath" in raw) {
    const svgPath = String((raw as { svgPath?: unknown }).svgPath ?? "");
    return (
      <span className="a2ui-icon" data-weight={weightBucket(props.weight)} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
          <path d={svgPath} fill="currentColor" />
        </svg>
      </span>
    );
  }
  const key = typeof raw === "string" ? raw : "";
  const IconComp = ICON_MAP[key] ?? Bookmark;
  return (
    <span className="a2ui-icon" data-weight={weightBucket(props.weight)} aria-hidden="true">
      <IconComp size={18} />
    </span>
  );
});

const WasmhatchVideo = createComponentImplementation(VideoApi, ({ props }) => {
  const [failed, setFailed] = useState(false);
  const url = typeof props.url === "string" ? props.url : "";
  const poster = typeof props.posterUrl === "string" ? props.posterUrl : undefined;

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (!url || failed) {
    return (
      <div className="a2ui-media-fallback" data-weight={weightBucket(props.weight)}>
        <span>{t`Video unavailable in this tab`}</span>
      </div>
    );
  }

  return (
    <div className="a2ui-video-wrap" data-weight={weightBucket(props.weight)}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        className="a2ui-video"
        controls
        preload="metadata"
        src={url}
        poster={poster}
        onError={() => setFailed(true)}
      />
    </div>
  );
});

const WasmhatchAudioPlayer = createComponentImplementation(AudioPlayerApi, ({ props }) => {
  const [failed, setFailed] = useState(false);
  const url = typeof props.url === "string" ? props.url : "";
  const description = typeof props.description === "string" ? props.description : "";

  useEffect(() => {
    setFailed(false);
  }, [url]);

  return (
    <figure className="a2ui-audio" data-weight={weightBucket(props.weight)}>
      {description && <figcaption className="a2ui-audio-caption">{description}</figcaption>}
      {!url || failed ? (
        <div className="a2ui-media-fallback">
          <span>{description || t`Audio unavailable in this tab`}</span>
        </div>
      ) : (
        <audio
          className="a2ui-audio-el"
          controls
          preload="metadata"
          src={url}
          onError={() => setFailed(true)}
        />
      )}
    </figure>
  );
});

const WasmhatchRow = createComponentImplementation(RowApi, ({ props, buildChild }) => (
  <div
    className="a2ui-row"
    data-justify={props.justify ?? "start"}
    data-align={props.align ?? "stretch"}
    data-weight={weightBucket(props.weight)}
  >
    {renderChildList(props.children as readonly ChildEntry[] | undefined, buildChild)}
  </div>
));

const WasmhatchColumn = createComponentImplementation(ColumnApi, ({ props, buildChild }) => (
  <div
    className="a2ui-column"
    data-justify={props.justify ?? "start"}
    data-align={props.align ?? "stretch"}
    data-weight={weightBucket(props.weight)}
  >
    {renderChildList(props.children as readonly ChildEntry[] | undefined, buildChild)}
  </div>
));

const WasmhatchList = createComponentImplementation(ListApi, ({ props, buildChild }) => {
  const children = Array.isArray(props.children) ? (props.children as readonly ChildEntry[]) : [];
  return (
    <div
      className="a2ui-list"
      role="list"
      data-direction={props.direction ?? "vertical"}
      data-align={props.align ?? "stretch"}
      data-weight={weightBucket(props.weight)}
    >
      {children.map((item, index) => {
        if (typeof item === "string") {
          return (
            <div key={`${item}-${index}`} className="a2ui-list-item" role="listitem">
              {buildChild(item)}
            </div>
          );
        }
        if (item && typeof item === "object" && typeof item.id === "string") {
          return (
            <div
              key={`${item.id}-${item.basePath ?? ""}-${index}`}
              className="a2ui-list-item"
              role="listitem"
            >
              {buildChild(item.id, item.basePath)}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
});

const WasmhatchCard = createComponentImplementation(CardApi, ({ props, buildChild }) => (
  <div className="a2ui-card" data-weight={weightBucket(props.weight)}>
    {typeof props.child === "string" ? buildChild(props.child) : null}
  </div>
));

function TabPanel({
  tabId,
  selected,
  onReveal,
  children
}: {
  tabId: string;
  selected: boolean;
  onReveal: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (selected) {
      el.removeAttribute("hidden");
    } else {
      el.setAttribute("hidden", "until-found");
    }
  }, [selected]);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const handleBeforeMatch = () => onReveal();
    el.addEventListener("beforematch", handleBeforeMatch);
    return () => el.removeEventListener("beforematch", handleBeforeMatch);
  }, [onReveal]);

  return (
    <div
      ref={panelRef}
      role="tabpanel"
      aria-labelledby={tabId}
      className="a2ui-tabpanel"
      hidden={!selected}
    >
      <div className="a2ui-tabpanel-body">{children}</div>
    </div>
  );
}

const WasmhatchTabs = createComponentImplementation(TabsApi, ({ props, buildChild }) => {
  const baseId = useId();
  const tabs = Array.isArray(props.tabs) ? props.tabs : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const safeIndex = tabs.length === 0 ? 0 : Math.min(activeIndex, tabs.length - 1);

  const selectAndFocus = useCallback((nextIndex: number) => {
    setActiveIndex(nextIndex);
    tabRefs.current[nextIndex]?.focus();
  }, []);

  const onTabListKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length <= 1) return;
    let next = -1;
    if (event.key === "ArrowRight") next = (safeIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (safeIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next >= 0) {
      event.preventDefault();
      selectAndFocus(next);
    }
  }, [safeIndex, selectAndFocus, tabs.length]);

  if (tabs.length === 0) return null;

  return (
    <div className="a2ui-tabs" data-weight={weightBucket(props.weight)}>
      <div
        className="a2ui-tablist"
        role="tablist"
        onKeyDown={onTabListKeyDown}
        {...({ focusgroup: "tablist nomemory" } as Record<string, unknown>)}
      >
        {tabs.map((tab, index) => {
          const selected = index === safeIndex;
          const tabId = `${baseId}-tab-${index}`;
          const title = tab?.title === undefined || tab?.title === null ? `${index + 1}` : String(tab.title);
          return (
            <button
              key={tabId}
              ref={(el) => { tabRefs.current[index] = el; }}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className="a2ui-tab"
              onClick={() => setActiveIndex(index)}
              {...(selected ? ({ focusgroupstart: "" } as Record<string, unknown>) : {})}
            >
              {title}
            </button>
          );
        })}
      </div>
      {tabs.map((tab, index) => {
        const tabId = `${baseId}-tab-${index}`;
        const childId = typeof tab?.child === "string" ? tab.child : "";
        return (
          <TabPanel
            key={tabId}
            tabId={tabId}
            selected={index === safeIndex}
            onReveal={() => setActiveIndex(index)}
          >
            {childId ? buildChild(childId) : null}
          </TabPanel>
        );
      })}
    </div>
  );
});

const WasmhatchModal = createComponentImplementation(ModalApi, ({ props, buildChild }) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const pointerDownOutsideRef = useRef(false);

  const openModal = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, []);

  const closeModal = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = () => {
      dialog.returnValue = "";
    };
    dialog.addEventListener("close", handleClose);

    const supportsClosedBy =
      typeof HTMLDialogElement !== "undefined" && "closedBy" in HTMLDialogElement.prototype;
    if (supportsClosedBy) {
      return () => dialog.removeEventListener("close", handleClose);
    }

    const isOutside = (event: PointerEvent) => {
      const rect = dialog.getBoundingClientRect();
      return (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      );
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerDownOutsideRef.current = event.target === dialog && isOutside(event);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (pointerDownOutsideRef.current && event.target === dialog && isOutside(event)) {
        dialog.close();
      }
      pointerDownOutsideRef.current = false;
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointerup", onPointerUp);
    return () => {
      dialog.removeEventListener("close", handleClose);
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return (
    <div className="a2ui-modal-host" data-weight={weightBucket(props.weight)}>
      <div
        className="a2ui-modal-trigger"
        onClickCapture={() => openModal()}
      >
        {typeof props.trigger === "string" ? buildChild(props.trigger) : null}
      </div>
      <dialog
        ref={dialogRef}
        className="a2ui-dialog"
        aria-label={t`Dialog`}
        {...({ closedby: "any" } as Record<string, unknown>)}
      >
        <div className="a2ui-dialog-header">
          <button
            type="button"
            className="a2ui-dialog-close"
            aria-label={t`Close`}
            onClick={closeModal}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="a2ui-dialog-body">
          {typeof props.content === "string" ? buildChild(props.content) : null}
        </div>
      </dialog>
    </div>
  );
});

const WasmhatchDivider = createComponentImplementation(DividerApi, ({ props }) => {
  const axis = props.axis ?? "horizontal";
  if (axis === "vertical") {
    return (
      <div
        className="a2ui-divider"
        data-axis="vertical"
        data-weight={weightBucket(props.weight)}
        role="separator"
        aria-orientation="vertical"
      />
    );
  }
  return <hr className="a2ui-divider" data-axis="horizontal" data-weight={weightBucket(props.weight)} />;
});

const WasmhatchButton = createComponentImplementation(ButtonApi, ({ props, buildChild }) => {
  const { notifySubmitAttempt } = useContext(SurfaceFormContext);
  const [busy, setBusy] = useState(false);
  const [showButtonError, setShowButtonError] = useState(false);
  const checkSlice = props as unknown as CheckablePropsSlice;
  const errorId = useId();

  useEffect(() => {
    if (checkSlice.isValid !== false) setShowButtonError(false);
  }, [checkSlice.isValid]);

  const handleClick = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    if (checkSlice.isValid === false) {
      notifySubmitAttempt();
      setShowButtonError(true);
      return;
    }
    setShowButtonError(false);
    const dispatch = props.action as ((options?: ActionDispatchOptions) => Promise<void>) | undefined;
    if (typeof dispatch !== "function") return;
    setBusy(true);
    const trusted = Boolean(event.nativeEvent.isTrusted);
    try {
      await withTrustedUserGesture(trusted, () =>
        dispatch({
          metadata: {
            extensions: {
              userActivated: trusted
            }
          }
        })
      );
    } finally {
      setBusy(false);
    }
  }, [busy, checkSlice.isValid, notifySubmitAttempt, props.action]);

  const buttonError =
    showButtonError && checkSlice.isValid === false ? checkSlice.validationErrors?.[0] ?? "" : "";

  return (
    <div className="a2ui-button-wrap" data-weight={weightBucket(props.weight)}>
      <InsideButtonContext.Provider value={true}>
        <button
          type="button"
          className="a2ui-button"
          data-variant={props.variant ?? "default"}
          disabled={busy}
          aria-busy={busy || undefined}
          aria-describedby={buttonError ? errorId : undefined}
          onClick={(event) => { void handleClick(event); }}
        >
          {typeof props.child === "string" ? buildChild(props.child) : null}
        </button>
      </InsideButtonContext.Provider>
      {buttonError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {buttonError}
        </p>
      )}
    </div>
  );
});

const WasmhatchTextField = createComponentImplementation(TextFieldApi, ({ props }) => {
  const inputId = useId();
  const errorId = useId();
  const checkSlice = props as unknown as CheckablePropsSlice;
  const { showError, errorMessage, markEdited, markBlurred } = useFieldValidation(checkSlice);
  const setValue = (props as unknown as { setValue?: (val: string | number) => void }).setValue;

  const variant = props.variant ?? "shortText";
  const label = props.label === undefined || props.label === null ? "" : String(props.label);
  const placeholder = typeof props.placeholder === "string" ? props.placeholder : undefined;
  const stringValue = props.value === undefined || props.value === null ? "" : String(props.value);

  const handleTextChange = useCallback((raw: string) => {
    markEdited();
    if (variant === "number") {
      if (raw.trim() === "") {
        setValue?.("");
      } else {
        const parsed = Number(raw);
        setValue?.(Number.isFinite(parsed) ? parsed : raw);
      }
      return;
    }
    setValue?.(raw);
  }, [markEdited, setValue, variant]);

  return (
    <div className="a2ui-field" data-weight={weightBucket(props.weight)}>
      <label htmlFor={inputId} className="a2ui-field-label">
        {label}
      </label>
      {variant === "longText" ? (
        <textarea
          id={inputId}
          className="a2ui-textarea"
          rows={3}
          value={stringValue}
          placeholder={placeholder}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          onChange={(event) => handleTextChange(event.target.value)}
          onBlur={markBlurred}
        />
      ) : (
        <input
          id={inputId}
          className="a2ui-input"
          type={variant === "obscured" ? "password" : variant === "number" ? "number" : "text"}
          inputMode={variant === "number" ? "decimal" : undefined}
          value={stringValue}
          placeholder={placeholder}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          onChange={(event) => handleTextChange(event.target.value)}
          onBlur={markBlurred}
        />
      )}
      {showError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
});

const WasmhatchCheckBox = createComponentImplementation(CheckBoxApi, ({ props }) => {
  const inputId = useId();
  const errorId = useId();
  const checkSlice = props as unknown as CheckablePropsSlice;
  const { showError, errorMessage, markEdited, markBlurred } = useFieldValidation(checkSlice);
  const setValue = (props as unknown as { setValue?: (val: boolean) => void }).setValue;
  const checked = Boolean(props.value);
  const label = props.label === undefined || props.label === null ? "" : String(props.label);

  return (
    <div className="a2ui-field" data-weight={weightBucket(props.weight)}>
      <label htmlFor={inputId} className="a2ui-choice-inline">
        <input
          id={inputId}
          type="checkbox"
          className="a2ui-checkbox"
          checked={checked}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          onChange={(event) => {
            markEdited();
            setValue?.(event.target.checked);
          }}
          onBlur={markBlurred}
        />
        <span>{label}</span>
      </label>
      {showError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
});

const WasmhatchChoicePicker = createComponentImplementation(ChoicePickerApi, ({ props }) => {
  const groupId = useId();
  const errorId = useId();
  const filterId = useId();
  const checkSlice = props as unknown as CheckablePropsSlice;
  const { showError, errorMessage, markEdited, markBlurred } = useFieldValidation(checkSlice);
  const setValue = (props as unknown as { setValue?: (val: string[]) => void }).setValue;
  const [query, setQuery] = useState("");

  const options = useMemo(
    () => (Array.isArray(props.options) ? props.options : []),
    [props.options]
  );
  const selectedValues = useMemo(
    () => (Array.isArray(props.value) ? props.value.map(String) : []),
    [props.value]
  );
  const selectedSet = useMemo(() => new Set(selectedValues), [selectedValues]);

  const variant = props.variant ?? "mutuallyExclusive";
  const displayStyle = props.displayStyle ?? "checkbox";
  const filterable = Boolean(props.filterable);
  const label = props.label === undefined || props.label === null ? "" : String(props.label);

  const filteredOptions = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!filterable || !trimmed) return options;
    return options.filter((opt) => {
      const optLabel = String(opt?.label ?? "").toLowerCase();
      const optValue = String(opt?.value ?? "").toLowerCase();
      return optLabel.includes(trimmed) || optValue.includes(trimmed);
    });
  }, [filterable, options, query]);

  const useNativeSelect =
    variant === "mutuallyExclusive" &&
    displayStyle !== "chips" &&
    !filterable &&
    options.length >= 6;

  if (useNativeSelect) {
    const current = selectedValues[0] ?? "";
    return (
      <div className="a2ui-field" data-weight={weightBucket(props.weight)}>
        {label && (
          <label htmlFor={groupId} className="a2ui-field-label">
            {label}
          </label>
        )}
        <select
          id={groupId}
          className="a2ui-select"
          value={current}
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
          onChange={(event) => {
            markEdited();
            setValue?.(event.target.value ? [event.target.value] : []);
          }}
          onBlur={markBlurred}
        >
          <option value="">{t`Select an option…`}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {String(opt.label ?? opt.value)}
            </option>
          ))}
        </select>
        {showError && (
          <p id={errorId} className="a2ui-field-error" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    );
  }

  const isExclusiveRadio = variant === "mutuallyExclusive" && displayStyle !== "chips";

  return (
    <fieldset
      className="a2ui-fieldset"
      data-weight={weightBucket(props.weight)}
      aria-invalid={showError || undefined}
      aria-describedby={showError ? errorId : undefined}
      onBlur={markBlurred}
    >
      {label && <legend className="a2ui-field-label">{label}</legend>}
      {filterable && (
        <input
          id={filterId}
          type="search"
          className="a2ui-input a2ui-choice-filter"
          value={query}
          placeholder={t`Filter options…`}
          aria-label={label ? `${label} — ${t`Filter options…`}` : t`Filter options…`}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div
        className={displayStyle === "chips" ? "a2ui-choice-chips" : "a2ui-choice-stack"}
      >
        {filteredOptions.map((opt, index) => {
          const optId = `${groupId}-opt-${index}`;
          const optLabel = String(opt.label ?? opt.value);
          const checked = selectedSet.has(opt.value);
          return (
            <label
              key={opt.value}
              htmlFor={optId}
              className={
                displayStyle === "chips"
                  ? checked
                    ? "a2ui-chip a2ui-chip-selected"
                    : "a2ui-chip"
                  : "a2ui-choice-inline"
              }
            >
              <input
                id={optId}
                type={isExclusiveRadio ? "radio" : "checkbox"}
                name={isExclusiveRadio ? groupId : undefined}
                className={displayStyle === "chips" ? "sr-only" : isExclusiveRadio ? "a2ui-radio" : "a2ui-checkbox"}
                checked={checked}
                onChange={(event) => {
                  markEdited();
                  if (variant === "mutuallyExclusive") {
                    if (displayStyle === "chips" && checked && !event.target.checked) {
                      setValue?.([]);
                    } else {
                      setValue?.([opt.value]);
                    }
                  } else {
                    const next = event.target.checked
                      ? [...selectedValues.filter((v) => v !== opt.value), opt.value]
                      : selectedValues.filter((v) => v !== opt.value);
                    setValue?.(next);
                  }
                }}
              />
              <span>{optLabel}</span>
            </label>
          );
        })}
      </div>
      {showError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </fieldset>
  );
});

const WasmhatchSlider = createComponentImplementation(SliderApi, ({ props }) => {
  const inputId = useId();
  const errorId = useId();
  const checkSlice = props as unknown as CheckablePropsSlice;
  const { showError, errorMessage, markEdited, markBlurred } = useFieldValidation(checkSlice);
  const setValue = (props as unknown as { setValue?: (val: number) => void }).setValue;

  const min = typeof props.min === "number" && Number.isFinite(props.min) ? props.min : 0;
  const max = typeof props.max === "number" && Number.isFinite(props.max) ? props.max : 100;
  const steps = typeof props.steps === "number" && props.steps >= 1 ? props.steps : undefined;
  const stepValue = steps ? (max - min) / steps : "any";
  const current = typeof props.value === "number" && Number.isFinite(props.value) ? props.value : min;
  const label = props.label === undefined || props.label === null ? "" : String(props.label);

  return (
    <div className="a2ui-field" data-weight={weightBucket(props.weight)}>
      <div className="a2ui-slider-head">
        <label htmlFor={inputId} className="a2ui-field-label">
          {label}
        </label>
        <output htmlFor={inputId} className="a2ui-slider-value">
          {current}
        </output>
      </div>
      <input
        id={inputId}
        type="range"
        className="a2ui-slider"
        min={min}
        max={max}
        step={stepValue}
        value={current}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        onChange={(event) => {
          markEdited();
          setValue?.(Number(event.target.value));
        }}
        onBlur={markBlurred}
      />
      {showError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
});

function isoToHtmlInputValue(raw: string, mode: "date" | "time" | "datetime-local"): string {
  if (!raw) return "";
  if (mode === "date") {
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : "";
  }
  if (mode === "time") {
    const timeMatch = raw.match(/T(\d{2}:\d{2})/) ?? raw.match(/^(\d{2}:\d{2})/);
    return timeMatch ? timeMatch[1] : "";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/);
    return localMatch ? localMatch[1] : "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function htmlInputValueToIso(raw: string, mode: "date" | "time" | "datetime-local"): string {
  if (!raw) return "";
  if (mode === "date") return raw;
  if (mode === "time") return raw.length === 5 ? `${raw}:00` : raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

const WasmhatchDateTimeInput = createComponentImplementation(DateTimeInputApi, ({ props }) => {
  const inputId = useId();
  const errorId = useId();
  const checkSlice = props as unknown as CheckablePropsSlice;
  const { showError, errorMessage, markEdited, markBlurred } = useFieldValidation(checkSlice);
  const setValue = (props as unknown as { setValue?: (val: string) => void }).setValue;

  const enableDate = props.enableDate ?? false;
  const enableTime = props.enableTime ?? false;
  const mode: "date" | "time" | "datetime-local" =
    enableDate && enableTime ? "datetime-local" : enableTime ? "time" : "date";

  const rawValue = typeof props.value === "string" ? props.value : "";
  const rawMin = typeof props.min === "string" ? isoToHtmlInputValue(props.min, mode) : undefined;
  const rawMax = typeof props.max === "string" ? isoToHtmlInputValue(props.max, mode) : undefined;
  const label = props.label === undefined || props.label === null ? "" : String(props.label);

  return (
    <div className="a2ui-field" data-weight={weightBucket(props.weight)}>
      {label && (
        <label htmlFor={inputId} className="a2ui-field-label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        type={mode}
        className="a2ui-input"
        value={isoToHtmlInputValue(rawValue, mode)}
        min={rawMin || undefined}
        max={rawMax || undefined}
        aria-invalid={showError || undefined}
        aria-describedby={showError ? errorId : undefined}
        onChange={(event) => {
          markEdited();
          setValue?.(htmlInputValueToIso(event.target.value, mode));
        }}
        onBlur={markBlurred}
      />
      {showError && (
        <p id={errorId} className="a2ui-field-error" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  );
});

const WASMHATCH_BASIC_CATALOG_DOCUMENT_OPTIONS = {
  schemaUri: "https://json-schema.org/draft/2020-12/schema",
  schemaId: BASIC_CATALOG_ID,
  title: "A2UI Basic Catalog",
  description: "Unified catalog of basic A2UI components and functions.",
  instructions:
    'For layout, use the Row and Column components to organize other components.\n\n## Catalog Guidelines\n\n1. String Concatenation & Formatting: A2UI does not support binary operators like \'+\' or formatting symbols. To concatenate strings or dynamically inject data bindings into text, you must use the catalog function `formatString(value)` where the value string contains placeholders formatted as `${expression}`:\n   formatString("Hello ${/user/name}")\n\n2. Strict Hierarchy: You must strictly adhere to the requested component nesting and hierarchy. If the prompt specifies that a component is \'inside\' or \'contained in\' another component, you MUST place it as a child of that specific component, not as a sibling or in a different container.\n\n3. Validation Checks: When components support validation checks, specify any custom error messages directly as the \'message\' inside the check. Do NOT create separate text-display components to display validation errors.\n\n## Examples\n\nExample 1: Dynamic text form\n```json\n[\n  {\n    "version": "1.0",\n    "createSurface": {\n      "surfaceId": "main",\n      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",\n      "components": [\n        {\n          "id": "root",\n          "component": "Column",\n          "children": ["repField", "valueField"]\n        },\n        {\n          "id": "repField",\n          "component": "TextField",\n          "label": "Representative",\n          "value": {"@path": "/form/rep"},\n          "placeholder": "Enter name"\n        },\n        {\n          "id": "valueField",\n          "component": "TextField",\n          "label": "Deal Value",\n          "value": {"@path": "/form/value"},\n          "placeholder": "0.00",\n          "variant": "number",\n          "checks": [\n            {\n              "condition": {\n                "@call": "required",\n                "args": {"value": {"@path": "/form/value"}}\n              },\n              "message": "Deal value is required."\n            }\n          ]\n        }\n      ],\n      "dataModel": {\n        "form": {\n          "rep": "John Doe",\n          "value": 1500.00\n        }\n      }\n    }\n  }\n]\n```\n\nExample 2: Dynamic list with templates\n```json\n[\n  {\n    "version": "1.0",\n    "createSurface": {\n      "surfaceId": "main",\n      "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",\n      "components": [\n        {\n          "id": "root",\n          "component": "Card",\n          "child": "breedList"\n        },\n        {\n          "id": "breedList",\n          "component": "List",\n          "children": {\n            "path": "/breeds",\n            "componentId": "breedTemplate"\n          },\n          "direction": "horizontal"\n        },\n        {\n          "id": "breedTemplate",\n          "component": "Image",\n          "url": {"@path": "url"}\n        }\n      ],\n      "dataModel": {\n        "breeds": [\n          {\n            "url": "https://example.com/poodle.jpg"\n          },\n          {\n            "url": "https://example.com/lab.jpg"\n          }\n        ]\n      }\n    }\n  }\n]\n```',
  declaredProtocolVersion: "1.0",
  commonTypesUri: "common_types.json"
} as const;

function buildLocaleFunctions(localeOrGetter: string | (() => string)): FunctionImplementation[] {
  if (typeof localeOrGetter === "string") {
    return createBasicCatalogFunctions({ locale: localeOrGetter });
  }
  const cache = new Map<string, Map<string, FunctionImplementation>>();
  const forLocale = (loc: string) => {
    const key = loc || "en";
    let map = cache.get(key);
    if (!map) {
      map = new Map(createBasicCatalogFunctions({ locale: key }).map((fn) => [fn.name, fn]));
      cache.set(key, map);
    }
    return map;
  };
  const baseFunctions = createBasicCatalogFunctions({ locale: localeOrGetter() || "en" });
  return baseFunctions.map((baseFn) => ({
    ...baseFn,
    execute(args, context, abortSignal) {
      const impl = forLocale(localeOrGetter()).get(baseFn.name) ?? baseFn;
      return impl.execute(args, context, abortSignal);
    }
  }));
}

/**
 * Builds WasmHatch's pure-React A2UI v1.0 Basic Catalog (18 components + 14
 * locale-aware formatting/validation functions).
 */
export function createWasmhatchBasicCatalog(
  localeOrGetter: string | (() => string) = "en"
): Catalog<ReactCatalogComponent> {
  return new Catalog(
    BASIC_CATALOG_ID,
    "1.0",
    [
      WasmhatchText,
      WasmhatchImage,
      WasmhatchIcon,
      WasmhatchVideo,
      WasmhatchAudioPlayer,
      WasmhatchRow,
      WasmhatchColumn,
      WasmhatchList,
      WasmhatchCard,
      WasmhatchTabs,
      WasmhatchModal,
      WasmhatchDivider,
      WasmhatchButton,
      WasmhatchTextField,
      WasmhatchCheckBox,
      WasmhatchChoicePicker,
      WasmhatchSlider,
      WasmhatchDateTimeInput
    ],
    buildLocaleFunctions(localeOrGetter),
    {
      themeSchema: BasicCatalogThemeSchema,
      ...WASMHATCH_BASIC_CATALOG_DOCUMENT_OPTIONS
    }
  );
}
