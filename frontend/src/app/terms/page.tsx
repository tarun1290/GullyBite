import type { Metadata } from 'next';
import Link from 'next/link';
import LegalDocLayout, {
  LegalIntro,
  LegalSection,
  LegalSubsection,
  LegalParagraph,
  LegalList,
  LegalClauseList,
} from '@/components/shared/LegalDocLayout';
import { TERMS_VERSION, LEGAL_LAST_UPDATED } from '@/lib/constants/legal';

export const metadata: Metadata = {
  title: 'Terms of Service — GullyBite',
  description:
    'The Terms of Service governing your use of the GullyBite platform operated by Doteye Labs, including the Beta Program terms, payments, liability, and governing law.',
};

export default function TermsPage() {
  return (
    <LegalDocLayout
      title="Terms of Service — GullyBite"
      lastUpdated={LEGAL_LAST_UPDATED}
      version={TERMS_VERSION}
    >
      <LegalIntro>
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your use of the
          GullyBite platform (&ldquo;Platform&rdquo;), operated by Doteye Labs
          (&ldquo;Company&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;,
          &ldquo;our&rdquo;), with registered office in India.
        </p>
        <p>
          By creating an account, accessing, or using the Platform, you
          (&ldquo;Restaurant&rdquo;, &ldquo;you&rdquo;, &ldquo;your&rdquo;)
          agree to be bound by these Terms.
        </p>
      </LegalIntro>

      <LegalSection heading="1. Services Provided">
        <LegalParagraph>
          GullyBite is a software-as-a-service platform that enables
          restaurants to:
        </LegalParagraph>
        <LegalList
          items={[
            'Manage their menu and operations through our dashboard',
            "Connect a WhatsApp Business Account via Meta's Embedded Signup",
            'Synchronize their product catalog to Meta Commerce Manager',
            'Receive and process orders placed by their customers through WhatsApp',
            'Accept payments from customers via integrated payment processors (Razorpay)',
            'Communicate with their customers via WhatsApp messages',
          ]}
        />
      </LegalSection>

      <LegalSection heading="2. Eligibility">
        <LegalParagraph>You represent that:</LegalParagraph>
        <LegalList
          items={[
            'You are at least 18 years of age and have the legal capacity to enter into these Terms',
            'You are an authorized representative of the restaurant business being registered',
            'You hold valid business registrations including but not limited to GST registration (where applicable), FSSAI license, and any other licenses required to operate a food business in India',
            'You will provide accurate and current information during signup and keep it updated',
          ]}
        />
      </LegalSection>

      <LegalSection heading="3. Restaurant Responsibilities">
        <LegalParagraph>You are solely responsible for:</LegalParagraph>
        <LegalList
          items={[
            'The accuracy of menu items, prices, availability, and descriptions',
            'Food quality, hygiene, packaging, and compliance with FSSAI regulations',
            'Fulfilling orders received through the Platform',
            'Communicating with your customers professionally and lawfully',
            'Handling customer complaints, refunds, and disputes related to your food or service',
            'Complying with all applicable tax obligations including GST collection and remittance',
            'Maintaining the security of your account credentials',
            'All content (menu items, descriptions, images) uploaded to the Platform, and you warrant you have rights to use such content',
          ]}
        />
      </LegalSection>

      <LegalSection heading="4. WhatsApp and Meta Integration; Beta Program">
        <LegalSubsection heading="4.1 Meta Integration">
          <LegalParagraph>You acknowledge that:</LegalParagraph>
          <LegalList
            items={[
              "The Platform integrates with Meta's WhatsApp Business APIs and Commerce Manager",
              "You must comply with Meta's WhatsApp Business Platform Policy, Commerce Policy, and Terms of Service",
              'The WhatsApp Business Account, phone number, and Meta Commerce catalog connected to the Platform belong to you, not to us',
              'Meta may impose limits, suspensions, or restrictions on your account independently of us',
              "We act as a technology provider facilitating your use of Meta's services and are not responsible for Meta's policy decisions or service availability",
            ]}
          />
        </LegalSubsection>

        <LegalSubsection heading="4.2 Beta Program Participation">
          <LegalParagraph>You acknowledge and agree that:</LegalParagraph>
          <LegalClauseList
            items={[
              {
                label: '(a)',
                body: (
                  <LegalParagraph>
                    GullyBite is currently in the process of obtaining Meta App
                    Review approval for its Tech Provider integration. Until
                    such approval is granted, the Platform operates under
                    Meta&apos;s &ldquo;Standard Access&rdquo; tier with
                    operational and quantitative limits on the number of
                    WhatsApp Business Accounts that may be connected to the
                    Platform at any given time.
                  </LegalParagraph>
                ),
              },
              {
                label: '(b)',
                body: (
                  <>
                    <LegalParagraph>
                      Your onboarding to the Platform during this period is on
                      a &ldquo;Beta Program&rdquo; basis. You are being granted
                      early access as a beta participant, and acknowledge that:
                    </LegalParagraph>
                    <LegalClauseList
                      items={[
                        {
                          label: '(i)',
                          body: (
                            <LegalParagraph>
                              Some Platform features may be partial,
                              experimental, or subject to change without prior
                              notice;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(ii)',
                          body: (
                            <LegalParagraph>
                              Performance, uptime, scaling capacity, and
                              Meta-imposed messaging limits may differ from
                              those available under standard production access;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iii)',
                          body: (
                            <LegalParagraph>
                              We may communicate with you more frequently than
                              under standard operations to gather feedback,
                              report issues, or coordinate updates;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iv)',
                          body: (
                            <LegalParagraph>
                              Your continued access depends on the
                              Platform&apos;s compliance with Meta&apos;s
                              policies, which are outside our sole control.
                            </LegalParagraph>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                label: '(c)',
                body: (
                  <>
                    <LegalParagraph>You agree to:</LegalParagraph>
                    <LegalClauseList
                      items={[
                        {
                          label: '(i)',
                          body: (
                            <LegalParagraph>
                              Provide reasonable feedback regarding your
                              experience with the Platform during the Beta
                              Program;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(ii)',
                          body: (
                            <LegalParagraph>
                              Report any errors, defects, or issues that
                              materially affect your use of the Platform to us
                              promptly via the contact channels we designate;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iii)',
                          body: (
                            <LegalParagraph>
                              Cooperate with us in good faith for any
                              troubleshooting or remediation steps;
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iv)',
                          body: (
                            <LegalParagraph>
                              Not publicly disparage the Platform during the
                              Beta Program based on issues you have not first
                              given us a reasonable opportunity to address.
                            </LegalParagraph>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                label: '(d)',
                body: (
                  <>
                    <LegalParagraph>
                      Re-execution of Terms upon Standard Access:
                    </LegalParagraph>
                    <LegalClauseList
                      items={[
                        {
                          label: '(i)',
                          body: (
                            <LegalParagraph>
                              Once GullyBite obtains Meta App Review approval
                              and the Platform transitions to standard
                              production operations, we will issue an updated
                              version of these Terms and the Privacy Policy
                              reflecting the standard operational arrangement
                              (which may include updated fee terms, removal of
                              beta-specific limitations, additional features,
                              and other changes).
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(ii)',
                          body: (
                            <LegalParagraph>
                              You agree that upon being notified of such
                              updated Terms (via email and/or dashboard
                              notification), you will be required to re-accept
                              the updated Terms within thirty (30) days to
                              continue using the Platform.
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iii)',
                          body: (
                            <LegalParagraph>
                              Failure to re-accept the updated Terms within the
                              said period may result in suspension of your
                              account until acceptance is recorded.
                            </LegalParagraph>
                          ),
                        },
                        {
                          label: '(iv)',
                          body: (
                            <LegalParagraph>
                              Until such re-acceptance occurs, these Beta
                              Program Terms shall continue to apply.
                            </LegalParagraph>
                          ),
                        },
                      ]}
                    />
                  </>
                ),
              },
              {
                label: '(e)',
                body: (
                  <>
                    <LegalParagraph>Liability During Beta:</LegalParagraph>
                    <LegalParagraph>
                      During the Beta Program, our aggregate liability to you
                      for any cause arising out of or relating to the Platform
                      is further limited to the lesser of (i) the amount stated
                      in Section 11 of these Terms, or (ii) ₹10,000 (Indian
                      Rupees Ten Thousand). This Beta-specific liability cap
                      shall cease to apply once you have accepted the updated
                      Terms upon transition to standard production access.
                    </LegalParagraph>
                  </>
                ),
              },
            ]}
          />
        </LegalSubsection>
      </LegalSection>

      <LegalSection heading="5. Payments">
        <LegalList
          items={[
            'Customer payments are processed by Razorpay (or other licensed payment processors we may integrate)',
            "Funds collected from your customers are settled to your linked bank account by Razorpay according to Razorpay's settlement schedule",
            'We may charge subscription fees, transaction fees, or other charges as communicated separately',
            'All fees are exclusive of applicable taxes (GST), which you are responsible for',
            "Refunds, chargebacks, and payment disputes are handled per Razorpay's policies and your separate agreement with Razorpay",
          ]}
        />
      </LegalSection>

      <LegalSection heading="6. Acceptable Use">
        <LegalParagraph>You shall not:</LegalParagraph>
        <LegalList
          items={[
            'Use the Platform for any unlawful purpose',
            'Upload menu items or content that is illegal, offensive, infringing, or violates any law',
            "Use the Platform to send spam, unsolicited promotional messages, or content that violates Meta's WhatsApp Business Policy",
            'Attempt to reverse engineer, hack, or disrupt the Platform',
            'Resell, sublicense, or provide the Platform to third parties without our written consent',
            'Use the Platform in any manner that could damage, disable, overburden, or impair it',
          ]}
        />
      </LegalSection>

      <LegalSection heading="7. Intellectual Property">
        <LegalList
          items={[
            'The Platform, including its design, code, branding, and documentation, is owned by Doteye Labs and protected by applicable intellectual property laws',
            'You grant us a non-exclusive, royalty-free license to use the content you upload (menu items, descriptions, images, restaurant name and logo) solely for the purpose of operating the Platform and providing the services to you',
            'We grant you a limited, non-exclusive, non-transferable license to use the Platform during your active subscription',
          ]}
        />
      </LegalSection>

      <LegalSection heading="8. Data and Privacy">
        <LegalParagraph>
          Our handling of your data and your customers&apos; data is governed
          by our{' '}
          <Link href="/privacy" className="font-medium text-acc underline">
            Privacy Policy
          </Link>
          , available at https://gully-bite.vercel.app/privacy. By accepting
          these Terms you confirm you have read and agreed to the Privacy
          Policy.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="9. Service Availability">
        <LegalParagraph>
          We will make commercially reasonable efforts to keep the Platform
          available but do not guarantee uninterrupted service. Scheduled
          maintenance, third-party outages (Meta, Razorpay, hosting
          providers), and force majeure events may cause interruptions.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="10. Termination">
        <LegalList
          items={[
            'You may terminate your account at any time by written notice',
            "We may suspend or terminate your account if you breach these Terms, violate Meta's or Razorpay's policies, engage in fraudulent activity, or fail to pay fees due",
            "Upon termination, your access to the Platform ceases; your customers' order data and your menu data may be retained per our Privacy Policy retention periods",
          ]}
        />
      </LegalSection>

      <LegalSection heading="11. Limitation of Liability">
        <LegalParagraph>
          To the maximum extent permitted by law:
        </LegalParagraph>
        <LegalList
          items={[
            'The Platform is provided "as is" without warranties of any kind',
            'Our total liability arising out of or relating to these Terms shall not exceed the fees paid by you to us in the three (3) months preceding the event giving rise to the claim',
            'We are not liable for indirect, consequential, incidental, or punitive damages, including lost profits or lost data',
            "We are not responsible for losses arising from Meta's or Razorpay's actions, decisions, or service interruptions",
          ]}
        />
      </LegalSection>

      <LegalSection heading="12. Indemnification">
        <LegalParagraph>
          You agree to indemnify and hold Doteye Labs harmless from any claims,
          damages, losses, or expenses arising from:
        </LegalParagraph>
        <LegalList
          items={[
            'Your violation of these Terms',
            'Your violation of any applicable law including FSSAI, GST, or consumer protection laws',
            'Your menu content, food quality, fulfillment, or customer interactions',
            "Your violation of Meta's or Razorpay's policies",
          ]}
        />
      </LegalSection>

      <LegalSection heading="13. Changes to Terms">
        <LegalParagraph>
          We may update these Terms from time to time. Material changes will be
          notified to you via email or dashboard notification at least 14 days
          before they take effect. Continued use of the Platform after changes
          take effect constitutes acceptance.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="14. Governing Law and Jurisdiction">
        <LegalParagraph>
          These Terms are governed by the laws of India. Any disputes arising
          from or relating to these Terms shall be subject to the exclusive
          jurisdiction of the courts located in Hyderabad, Telangana, India.
        </LegalParagraph>
      </LegalSection>

      <LegalSection heading="15. Contact">
        <LegalParagraph>
          For questions about these Terms, contact us at:
        </LegalParagraph>
        <LegalParagraph>
          Doteye Labs
          <br />
          Email: outreach@doteyelabs.com
        </LegalParagraph>
      </LegalSection>

      <LegalParagraph>
        <span className="font-semibold text-tx">
          By ticking the &ldquo;I agree to the Terms of Service and Privacy
          Policy&rdquo; checkbox during signup, you acknowledge that you have
          read, understood, and agreed to these Terms.
        </span>
      </LegalParagraph>
    </LegalDocLayout>
  );
}
